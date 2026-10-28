import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AuthSession } from '../src/auth.mjs'
import { Connector } from '../src/connector.mjs'
import { CredentialStore } from '../src/credentials.mjs'
import { APIError } from '../src/http.mjs'

const server = 'https://pipa.test'
function tokens(letter = 'a') {
  return { account_id: '11111111-1111-4111-8111-111111111111', grant_id: '22222222-2222-4222-8222-222222222222',
    access_token: `paa1_${letter.repeat(43)}`, refresh_token: `par1_${letter.repeat(43)}`, token_type: 'Bearer',
    scopes: ['tasks:read', 'tasks:write'], access_expires_at: Math.floor(Date.now() / 1000) + 900, expires_at: Math.floor(Date.now() / 1000) + 86400 }
}
const catalog = { tools: [{ name: 'pipa_task_create', inputSchema: { type: 'object' }, mutation: true, destructive: false }] }

async function fixture(t, handler, value = tokens()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-status-test-'))
  const store = new CredentialStore({ directory, server, profile: 'test' })
  if (value) await store.save(value)
  const request = async (_server, route, options) => {
    const result = await handler(route, options)
    if (route === '/help') return result ?? {}
    if (route === '/me') {
      const meta = await store.metadata()
      return result ?? { user: { id: meta.account_id }, grant_id: meta.grant_id, scopes: meta.scopes, expires_at: meta.expires_at }
    }
    return result ?? (route === '/tools' ? catalog : tokens('b'))
  }
  const auth = new AuthSession({ server, store, request }); auth.access = value
  const connector = new Connector({ server, auth, request })
  const client = new Client({ name: 'status-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  t.after(async () => { await client.close(); await connector.close(); await rm(directory, { recursive: true, force: true }) })
  await connector.connect(serverTransport); await client.connect(clientTransport); await connector.discover()
  return { store, auth, connector, client, value }
}

test('MCP status verifies remotely and warns without disconnecting a healthy expiring connection', async (t) => {
  const { client, value, store } = await fixture(t, async (route) => route.includes('/tools/') ? { task: { id: 'saved' } } : undefined)
  const status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'connected'); assert.equal(status.next_action, 'none')
  assert.ok(Number.isSafeInteger(status.checked_at)); assert.equal(status.expires_soon, true)
  assert.equal(status.connection_notice.code, 'authorization_expiring_soon')
  const saved = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(saved.isError, false); assert.equal(saved.structuredContent.task.id, 'saved')
  assert.equal(saved.structuredContent.connection_notice.expires_at, value.expires_at)
  assert.ok(!JSON.stringify(saved).includes(value.access_token))
  assert.ok(!JSON.stringify(status).includes(value.refresh_token)); assert.ok(await store.metadata())
})

test('revocation is surfaced immediately as MCP isError with a reconnect action and removes business tools', async (t) => {
  let calls = 0
  const { client, store, connector } = await fixture(t, async (route) => {
    if (route.includes('/tools/')) { calls++; throw new APIError('authorization_revoked', 401) }
  })
  const result = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error, 'authorization_revoked')
  assert.equal(result.structuredContent.connection.state, 'revoked')
  assert.equal(result.structuredContent.next_action, 'pipa_connect'); assert.equal(result.structuredContent.reconnect_required, true)
  assert.equal(calls, 1); assert.equal(await store.metadata(), null); assert.equal(connector.tools.length, 0)
  const status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'revoked') // The background discovery must not erase the reason as signed_out.
})

test('network failure preserves credentials and reports offline, then recovers without reauthorization', async (t) => {
  let offline = false
  const { client, store } = await fixture(t, async (route) => {
    if (offline) throw new APIError('network_error')
    if (route.includes('/tools/')) return { task: { id: 'saved' } }
  })
  offline = true
  const failed = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.connection.state, 'offline')
  assert.equal(failed.structuredContent.next_action, 'retry_later'); assert.equal(failed.structuredContent.reconnect_required, false)
  const status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'offline'); assert.equal(status.connection_notice, undefined)
  assert.ok(await store.metadata())
  offline = false
  assert.equal((await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent.state, 'connected')
})

test('gateway HTML 401 is blocked, not revocation; a business 403 remains a permission error', async (t) => {
  let failure
  const { client, store } = await fixture(t, async (route) => { if (route.includes('/tools/')) throw failure })
  failure = new APIError('gateway_login_or_non_json: challenge', 401)
  const gateway = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(gateway.structuredContent.connection.state, 'blocked')
  assert.equal(gateway.structuredContent.next_action, 'check_server_configuration')
  assert.equal(gateway.structuredContent.reconnect_required, false); assert.ok(await store.metadata())
  await client.callTool({ name: 'pipa_connection_status', arguments: {} })
  failure = new APIError('insufficient_scope', 403)
  const forbidden = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(forbidden.isError, true); assert.equal(forbidden.structuredContent.error, 'insufficient_scope')
  assert.equal(forbidden.structuredContent.connection.state, 'connected')
  assert.equal(forbidden.structuredContent.next_action, 'review_permissions'); assert.ok(await store.metadata())
})

test('explicit short-lived access expiry refreshes once and repeats only the rejected request unchanged', async (t) => {
  const bodies = [], access = []
  let refreshes = 0
  const { client } = await fixture(t, async (route, options) => {
    if (route === '/token') { refreshes++; return tokens('b') }
    if (route.includes('/tools/')) {
      bodies.push(JSON.stringify(options.body)); access.push(options.token)
      if (bodies.length === 1) throw new APIError('access_token_expired', 401)
      return { task: { id: 'saved' } }
    }
  })
  const result = await client.callTool({ name: 'pipa_task_create', arguments: { title: 'test', operation_id: '77777777-7777-4777-8777-777777777777' } })
  assert.equal(result.isError, false); assert.equal(refreshes, 1)
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.notEqual(access[0], access[1])
})

test('a second access expiry stops, while an ambiguous access rejection preserves shared login without replaying', async (t) => {
  for (const code of ['access_token_expired', 'invalid_grant']) {
    let calls = 0, refreshes = 0
    const { client, store } = await fixture(t, async (route) => {
      if (route === '/token') { refreshes++; return tokens('b') }
      if (route.includes('/tools/')) { calls++; throw new APIError(code, 401) }
    })
    const result = await client.callTool({ name: 'pipa_task_create', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.connection.state, 'unverified')
    assert.equal(result.structuredContent.next_action, 'pipa_connection_status')
    assert.equal(calls, code === 'access_token_expired' ? 2 : 1); assert.equal(refreshes, code === 'access_token_expired' ? 1 : 0)
    assert.ok(await store.metadata())
    assert.equal((await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent.state, 'connected')
  }
})

test('refresh response loss retries once and reports offline without forcing a new login', async (t) => {
  let failRefresh = false, calls = 0
  const { client, auth, store } = await fixture(t, async (route) => {
    if (route === '/token' && failRefresh) { calls++; throw new APIError('network_error') }
  })
  auth.access = null; failRefresh = true; auth.sleep = async () => {}
  await auth.rejectAccess(tokens().access_token)
  const result = await client.callTool({ name: 'pipa_task_create', arguments: { operation_id: '77777777-7777-4777-8777-777777777777' } })
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error, 'refresh_unavailable')
  assert.equal(result.structuredContent.connection.state, 'offline')
  assert.equal(result.structuredContent.reconnect_required, false)
  assert.equal(calls, 2); assert.ok(await store.metadata())
})

test('a signed-out Agent receives an explicit connect action, not an unavailable-tool dead end', async (t) => {
  const { client } = await fixture(t, async () => { throw new Error('must not request the server without credentials') }, null)
  const status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'signed_out'); assert.equal(status.next_action, 'pipa_connect')
  const result = await client.callTool({ name: 'pipa_task_create', arguments: {} })
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error, 'authorization_required')
  assert.equal(result.structuredContent.next_action, 'pipa_connect')
})

test('an unknown JSON 401 or malformed catalog is configuration failure, not confirmed invalid credentials', async (t) => {
  let failure
  const { client, store } = await fixture(t, async (route) => { if (failure && route === '/me') throw failure })
  failure = new APIError('request_failed', 401)
  let status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'blocked'); assert.equal(status.reconnect_required, false)
  assert.ok(await store.metadata())
  failure = null
  const malformed = await fixture(t, async (route) => route === '/tools' ? { tools: [{ name: 123 }] } : undefined)
  assert.equal((await malformed.auth.status()).state, 'blocked')
  assert.equal((await malformed.auth.status()).code, 'server_configuration_error')
  status = (await malformed.client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'connected', 'lightweight identity checks must not depend on catalog parsing')
  assert.ok(await malformed.store.metadata())
})

test('expired authorization can reconnect through MCP and rediscover tools without manual credential edits', async (t) => {
  let expired = true, approved
  const approval = new Promise((resolve) => { approved = resolve })
  const replacement = { ...tokens('c'), grant_id: '33333333-3333-4333-8333-333333333333' }
  const { client, auth, connector, store } = await fixture(t, async (route) => {
    if (route.includes('/tools/') && expired) throw new APIError('authorization_expired', 401)
    if (route === '/device') return { device_code: `pad1_${'d'.repeat(43)}`, user_code: 'ABCDEFG234567',
      verification_uri_complete: `${server}/agent/authorize#code=ABCDEFG234567`, expires_at: Math.floor(Date.now() / 1000) + 600, interval: 5 }
    if (route === '/token') return replacement
  })
  assert.equal((await client.callTool({ name: 'pipa_task_create', arguments: {} })).structuredContent.connection.state, 'expired')
  expired = false; auth.sleep = async () => {}
  const original = auth.onChange
  auth.onChange = () => { original(); approved() }
  const pairing = await client.callTool({ name: 'pipa_connect', arguments: {} })
  assert.equal(pairing.isError, false); assert.match(pairing.structuredContent.verification_uri, /\/agent\/authorize#code=/)
  assert.equal(pairing.structuredContent.device_code, undefined)
  await approval; await connector.discover()
  const status = (await client.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
  assert.equal(status.state, 'connected'); assert.equal(status.grant_id, replacement.grant_id)
  assert.equal((await store.metadata()).grant_id, replacement.grant_id)
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'pipa_task_create'))
})
