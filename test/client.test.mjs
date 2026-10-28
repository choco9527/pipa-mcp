import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PipaClient, validateCatalog } from '../src/client.mjs'
import { AuthSession } from '../src/auth.mjs'
import { CredentialStore } from '../src/credentials.mjs'
import { Connector } from '../src/connector.mjs'
import { APIError } from '../src/http.mjs'

const server = 'https://pipa.test'
const operation = '77777777-7777-4777-8777-777777777777'
const tool = (name = 'pipa_task_create', mutation = true) => ({ name, inputSchema: { type: 'object' }, mutation, destructive: false })
function tokens(letter = 'a') {
  return { account_id: '11111111-1111-4111-8111-111111111111', grant_id: '22222222-2222-4222-8222-222222222222',
    access_token: `paa1_${letter.repeat(43)}`, refresh_token: `par1_${letter.repeat(43)}`, token_type: 'Bearer', scopes: ['tasks:read', 'tasks:write'],
    access_expires_at: Math.floor(Date.now() / 1000) + 900, expires_at: Math.floor(Date.now() / 1000) + 86400 }
}
function me(value = tokens()) { return { user: { id: value.account_id }, grant_id: value.grant_id, scopes: value.scopes, expires_at: value.expires_at } }
const simpleAuth = () => ({ async accessToken() { return 'test-access' }, close() {} })
async function fixture(t, request) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-client-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new CredentialStore({ directory, server, profile: 'shared-test' })
  const value = tokens(); await store.save(value)
  const auth = new AuthSession({ server, store, request }); auth.access = value
  t.after(() => auth.close())
  return { store, auth, client: new PipaClient({ server, auth, request }) }
}

test('catalog boundary validates schemas, duplicate/reserved names and mutation metadata', () => {
  const valid = tool('pipa_tasks_search', false)
  assert.deepEqual(validateCatalog({ tools: [valid] }), [valid])
  for (const value of [null, [], {}, { tools: null }, { tools: [valid, valid] }, { tools: [tool('pipa_connect')] },
    { tools: [tool('pipa_/escape')] }, { tools: [tool('not_pipa')] }, { tools: [{ ...valid, mutation: undefined }] },
    { tools: [{ ...valid, destructive: 0 }] }, { tools: [{ ...valid, inputSchema: {} }] }, { tools: Array(201).fill(valid) }]) {
    assert.throws(() => validateCatalog(value), { code: 'invalid_tool_catalog' })
  }
})

test('plain client lists server tools and calls HTTP directly without an MCP transport', async () => {
  const routes = []
  const client = new PipaClient({ server, auth: simpleAuth(), request: async (_origin, route, options) => {
    routes.push(route)
    if (route === '/tools') return { tools: [tool()] }
    assert.equal(options.method, 'POST'); assert.equal(options.token, 'test-access')
    return { task: { title: options.body.title } }
  } })
  const catalog = await client.listTools()
  catalog[0].mutation = false
  assert.equal(client.tools[0].mutation, true)
  assert.deepEqual(await client.callTool('pipa_task_create', { title: 'example' }), { task: { title: 'example' } })
  assert.deepEqual(routes, ['/tools', '/tools/pipa_task_create'])
})

test('unknown names and invalid arguments never dispatch business requests', async () => {
  const routes = []
  const client = new PipaClient({ server, auth: simpleAuth(), request: async (_origin, route) => {
    routes.push(route); return { tools: [] }
  } })
  for (const name of ['pipa_connect', 'pipa_/escape', '', null]) await assert.rejects(client.callTool(name), { code: 'invalid_tool_name' })
  for (const args of [null, [], { value: undefined }, { value: NaN }, { value: () => {} }, { value: 1n }]) {
    await assert.rejects(client.callTool('pipa_task_create', args), { code: 'invalid_arguments' })
  }
  assert.deepEqual(routes, [])
  await assert.rejects(client.callTool('pipa_not_allowed'), /tool_not_available/)
  assert.deepEqual(routes, ['/tools'])
})

test('write retry uses an immutable snapshot and the same operation ID', async () => {
  const original = { operation_id: operation, changes: { title: 'initial' } }, sent = []
  const client = new PipaClient({ server, auth: simpleAuth(), request: async (_origin, route, options) => {
    if (route === '/tools') return { tools: [tool()] }
    sent.push(JSON.stringify(options.body))
    if (sent.length === 1) { original.changes.title = 'caller changed'; throw new APIError('network_error') }
    return { task: { title: options.body.changes.title } }
  } })
  assert.equal((await client.callTool('pipa_task_create', original)).task.title, 'initial')
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1])
  assert.equal(JSON.parse(sent[0]).operation_id, operation)
})

test('unsafe writes and business conflicts are never retried', async () => {
  for (const [body, error] of [[{}, new APIError('network_error')], [{ operation_id: 'bad' }, new APIError('network_error')],
    [{ operation_id: operation }, new APIError('version_conflict', 409)], [{ operation_id: operation }, new APIError('insufficient_scope', 403)]]) {
    let calls = 0
    const client = new PipaClient({ server, auth: simpleAuth(), request: async (_origin, route) => {
      if (route === '/tools') return { tools: [tool()] }
      calls++; throw error
    } })
    await assert.rejects(client.callTool('pipa_task_create', body), { code: error.code })
    assert.equal(calls, 1)
  }
})

test('status verifies remotely, preserves credentials while offline, and recovers', async (t) => {
  let offline = false
  const { client, store } = await fixture(t, async (_origin, route) => {
    if (offline) throw new APIError('network_error')
    if (route === '/me') return me(await store.metadata())
    return { tools: [tool()] }
  })
  const connected = await client.status()
  assert.equal(connected.state, 'connected'); assert.ok(Number.isSafeInteger(connected.checked_at))
  assert.equal(connected.connection_notice.code, 'authorization_expiring_soon')
  offline = true
  const status = await client.status()
  assert.equal(status.state, 'offline'); assert.equal(status.reconnect_required, false)
  assert.ok(await store.metadata()); assert.ok(!JSON.stringify(status).includes('paa1_'))
  offline = false; assert.equal((await client.status()).state, 'connected')
})

test('malformed server result is rejected and does not pretend a write succeeded', async (t) => {
  const { client, auth, store } = await fixture(t, async (_origin, route) => route === '/tools' ? { tools: [tool()] } : ['not-an-object'])
  await assert.rejects(client.callTool('pipa_task_create', {}), { code: 'invalid_server_response' })
  assert.equal((await auth.status()).state, 'blocked'); assert.ok(await store.metadata())
})

test('terminal authorization failure removes the shared catalog and returns revoked status', async (t) => {
  let revoked = false
  const { client, store } = await fixture(t, async () => {
    if (revoked) throw new APIError('authorization_revoked', 401)
    return { tools: [tool()] }
  })
  await client.listTools(); revoked = true
  assert.equal((await client.status()).state, 'revoked')
  assert.equal(await store.metadata(), null); assert.equal(client.tools, null)
})

test('CLI and MCP sessions reuse one saved authorization without refresh rotations', async (t) => {
  const refreshes = [], routes = []
  const request = async (_origin, route, options) => {
    routes.push(route)
    if (route === '/token') { refreshes.push(options.body.refresh_token); return tokens(refreshes.length === 1 ? 'b' : 'c') }
    if (route === '/tools') return { tools: [tool('pipa_tasks_search', false)] }
    return { tasks: [] }
  }
  const { store, auth: cliAuth, client: cli } = await fixture(t, request)
  const mcpStore = new CredentialStore({ directory: store.directory, server, profile: store.profile })
  const mcpAuth = new AuthSession({ server, store: mcpStore, request })
  const mcp = new Connector({ server, auth: mcpAuth, request }); t.after(() => mcp.close())
  cliAuth.access = null
  await Promise.all([cli.listTools(), mcp.discover()])
  assert.deepEqual(refreshes, [])
  assert.equal((await cli.callTool('pipa_tasks_search', {})).tasks.length, 0)
  assert.equal((await mcp.call('pipa_tasks_search', {})).isError, false)
  assert.equal((await mcpAuth.status()).state, 'connected')
  assert.ok(!routes.includes('/device')); assert.ok(!routes.includes('/logout'))
})

test('late old-grant rejection never clears a replacement connection or its catalog', async (t) => {
  let reject
  const rejected = new Promise((_, fail) => { reject = fail })
  const { client, store, auth } = await fixture(t, async (_origin, route) => route === '/tools' ? { tools: [tool()] } : rejected)
  await client.listTools()
  const call = client.callTool('pipa_task_create', {})
  await new Promise((resolve) => setImmediate(resolve))
  const replacement = { ...tokens('c'), grant_id: '33333333-3333-4333-8333-333333333333' }
  await store.save(replacement); auth.access = replacement
  reject(new APIError('authorization_revoked', 401))
  await assert.rejects(call, { code: 'authorization_revoked' })
  assert.equal((await store.metadata()).grant_id, replacement.grant_id)
  assert.equal(auth.access.access_token, replacement.access_token); assert.ok(client.tools)
})

test('access failure carries private request identity without exposing it in JSON', async () => {
  const generation = 'example-generation-fingerprint'
  const auth = { ...simpleAuth(), requestIdentity: () => ({ grantId: 'example-grant', credentialGeneration: generation }) }
  const client = new PipaClient({ server, auth, request: async () => { throw new APIError('insufficient_scope', 403) } })
  await assert.rejects(client.authorized('/tools'), (error) => {
    assert.equal(error.grantId, 'example-grant'); assert.equal(error.credentialGeneration, generation)
    assert.equal(error.pipaAccessResponse, true)
    assert.ok(!JSON.stringify(error).includes(generation)); assert.ok(!JSON.stringify(error).includes('pipaAccessResponse'))
    return true
  })
})

test('a sibling CLI refresh cannot make an older MCP access response erase the shared login', async (t) => {
  let reject
  const response = new Promise((_, fail) => { reject = fail })
  const { client, store, auth } = await fixture(t, async (_origin, route) => {
    if (route === '/tools') return { tools: [tool()] }
    return response
  })
  await client.listTools()
  const call = client.callTool('pipa_task_create', {})
  await new Promise((resolve) => setImmediate(resolve))
  const sibling = new AuthSession({ server, store, request: async (_origin, route) => route === '/help' ? {} : tokens('b') })
  t.after(() => sibling.close())
  await sibling.rejectAccess(tokens('a').access_token)
  await sibling.accessToken()
  reject(new APIError('invalid_grant', 401))
  await assert.rejects(call, { code: 'invalid_grant' })
  assert.equal((await store.credential(await store.metadata())).refresh_token, tokens('b').refresh_token)
  assert.equal((await auth.status()).reconnect_required, false)
  assert.ok(client.tools)
})

test('only a 401 access_token_expired response permits an authentication replay', async () => {
  for (const [code, status, expected] of [['access_token_expired', 401, 2], ['access_token_expired', 400, 1], ['unauthorized', 401, 1]]) {
    let calls = 0
    const client = new PipaClient({ server, auth: simpleAuth(), request: async () => { calls++; throw new APIError(code, status) } })
    await assert.rejects(client.authorized('/tools/pipa_task_create', { method: 'POST', body: {} }), { code })
    assert.equal(calls, expected)
  }
})

test('a propagated failure updates shared authorization state only once', async () => {
  let handled = 0
  const client = new PipaClient({ server, auth: { ...simpleAuth(), failed: async () => { handled++ } } })
  const failure = new APIError('network_error')
  assert.equal(await client.failed(failure), true)
  assert.equal(await client.failed(failure), false)
  assert.equal(handled, 1)
})

test('cancelled status never falls back to an earlier connected state', async (t) => {
  let cancelled = false, requests = 0
  const { client, store } = await fixture(t, async (_origin, route) => {
    requests++
    if (cancelled) throw new APIError('request_cancelled')
    return route === '/me' ? me(await store.metadata()) : { tools: [] }
  })
  assert.equal((await client.status()).state, 'connected')
  await assert.rejects(client.status({ signal: AbortSignal.abort() }), { code: 'request_cancelled' })
  assert.equal(requests, 1)
  cancelled = true
  await assert.rejects(client.status(), { code: 'request_cancelled' })
  assert.ok(await store.metadata())
})
