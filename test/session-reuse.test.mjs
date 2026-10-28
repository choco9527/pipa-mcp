import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuthSession } from '../src/auth.mjs'
import { CredentialStore } from '../src/credentials.mjs'
import { PipaClient } from '../src/client.mjs'
import { APIError } from '../src/http.mjs'
import { runCLI } from '../src/cli.mjs'

const server = 'https://pipa.test'
const tool = { name: 'pipa_tasks_search', inputSchema: { type: 'object' }, mutation: false, destructive: false }
function tokens(letter = 'a', extra = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { account_id: '11111111-1111-4111-8111-111111111111', grant_id: '22222222-2222-4222-8222-222222222222',
    access_token: `paa1_${letter.repeat(43)}`, refresh_token: `par1_${letter.repeat(43)}`, token_type: 'Bearer',
    scopes: ['tasks:read'], access_expires_at: now + 900, expires_at: now + 86400, ...extra }
}
async function fixture(t, value = tokens()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-reuse-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new CredentialStore({ directory, server, profile: 'test' })
  await store.withLock(() => store.save(value))
  return store
}

test('independent CLI commands reuse private access and catalog caches instead of refreshing each time', async (t) => {
  const store = await fixture(t), routes = []
  const request = async (_origin, route) => {
    routes.push(route)
    if (route === '/token') return tokens('b')
    if (route === '/me') { const meta = await store.metadata(); return { user: { id: meta.account_id }, ...meta } }
    return route === '/tools' ? { tools: [tool] } : { tasks: [] }
  }
  const runtimeFactory = async () => {
    const auth = new AuthSession({ server, store, request })
    return { auth, client: new PipaClient({ server, auth, request }) }
  }
  for (const args of [['status'], ['tools', 'list'], ['tools', 'show', tool.name], ['tasks', 'list']]) {
    const chunks = [], output = { write: (text) => chunks.push(text) }
    assert.equal(await runCLI([...args, '--json'], { runtimeFactory, output, errorOutput: output }), 0, chunks.join(''))
  }
  assert.deepEqual(routes, ['/me', '/tools', '/tools/pipa_tasks_search'])
})

test('concurrent sessions coalesce an expired cache into one refresh', async (t) => {
  const store = await fixture(t, tokens('a', { access_expires_at: Math.floor(Date.now() / 1000) - 1 })), used = []
  const request = async (_origin, route, options) => {
    if (route === '/help') return {}
    assert.equal(route, '/token'); used.push(options.body.refresh_token)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return tokens('b')
  }
  const sessions = Array.from({ length: 3 }, () => new AuthSession({ server, store, request }))
  assert.deepEqual(await Promise.all(sessions.map((auth) => auth.accessToken())), Array(3).fill(tokens('b').access_token))
  assert.deepEqual(used, [tokens().refresh_token])
})

test('a pre-consumption rate limit does not discard a refresh credential', async (t) => {
  const store = await fixture(t, { ...tokens(), access_token: undefined, access_expires_at: undefined })
  const auth = new AuthSession({ server, store, request: async (_origin, route) => {
    if (route === '/help') return {}
    throw new APIError('rate_limited', 429, 11000)
  } })
  await assert.rejects(auth.accessToken())
  assert.ok(await store.metadata())
  assert.equal((await auth.status()).reconnect_required, false)
})

test('expired catalogs and replacement grants cannot reuse a previous cached definition', async (t) => {
  const store = await fixture(t)
  await store.cacheCatalog(await store.metadata(), [tool])
  const file = await store.document('tools.json')
  await store.files.write('tools.json', { ...file, profiles: { ...file.profiles,
    [store.key]: { ...file.profiles[store.key], expires_at: Math.floor(Date.now() / 1000) - 1 } } })
  const routes = [], request = async (_origin, route) => { routes.push(route); return { tools: [tool] } }
  const auth = new AuthSession({ server, store, request }), client = new PipaClient({ server, auth, request })
  assert.equal((await client.listTools()).length, 1); assert.deepEqual(routes, ['/tools'])
  await store.withLock(() => store.save(tokens('b', { grant_id: '33333333-3333-4333-8333-333333333333' })))
  assert.equal((await client.definition(tool.name)).name, tool.name)
  assert.deepEqual(routes, ['/tools', '/tools'])
})

test('an authenticated but mismatched identity response cannot report connected', async (t) => {
  const store = await fixture(t)
  const request = async () => ({ user: { id: tokens().account_id }, grant_id: '33333333-3333-4333-8333-333333333333',
    scopes: tokens().scopes, expires_at: tokens().expires_at })
  const auth = new AuthSession({ server, store, request }), client = new PipaClient({ server, auth, request })
  assert.equal((await client.status()).state, 'blocked')
  assert.ok(await store.metadata())
})

test('a lost refresh response retries the same stable credential once without another login', async (t) => {
  const store = await fixture(t, tokens('a', { access_expires_at: Math.floor(Date.now() / 1000) - 1 })), bodies = []
  const auth = new AuthSession({ server, store, sleep: async () => {}, request: async (_origin, route, options) => {
    assert.equal(route, '/token'); assert.equal(options.timeoutMs, 15000)
    bodies.push(structuredClone(options.body))
    if (bodies.length === 1) throw new APIError('network_error')
    return tokens('b', { refresh_token: tokens().refresh_token })
  } })
  assert.equal(await auth.accessToken(), tokens('b').access_token)
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1])
  assert.equal((await store.credential(await store.metadata())).refresh_token, tokens().refresh_token)
})

test('cancelled refresh keeps login and a later session can simply try again', async (t) => {
  const store = await fixture(t, tokens('a', { access_expires_at: Math.floor(Date.now() / 1000) - 1 }))
  const controller = new AbortController()
  let calls = 0
  const auth = new AuthSession({ server, store, request: async () => { calls++; controller.abort(); throw new APIError('request_cancelled') } })
  await assert.rejects(auth.accessToken(controller.signal), { code: 'request_cancelled' })
  assert.equal(calls, 1); assert.ok(await store.metadata())
  const restarted = new AuthSession({ server, store, request: async () => tokens('b', { refresh_token: tokens().refresh_token }) })
  assert.equal(await restarted.accessToken(), tokens('b').access_token)
})

test('status does not stack a business retry around the refresh retry', async (t) => {
  const store = await fixture(t, tokens('a', { access_expires_at: Math.floor(Date.now() / 1000) - 1 }))
  let calls = 0
  const request = async () => { calls++; throw new APIError('network_error') }
  const auth = new AuthSession({ server, store, request, sleep: async () => {} }), client = new PipaClient({ server, auth, request })
  assert.equal((await client.status()).state, 'offline')
  assert.equal(calls, 2); assert.ok(await store.metadata())
})

test('first-use help is offline and tells a new user how to log in and query tasks', async () => {
  const chunks = [], output = { write: (text) => chunks.push(text) }
  const code = await runCLI(['help', 'quickstart', '--json'], { output,
    runtimeFactory: () => { throw new Error('help must not touch login or network') } })
  assert.equal(code, 0)
  const { help } = JSON.parse(chunks.join(''))
  for (const example of ['pipa login', 'pipa tasks list --json', 'pipa notes list --json', 'CLI', 'MCP']) assert.ok(help.includes(example))
})
