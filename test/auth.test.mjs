import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuthSession, validateTokens } from '../src/auth.mjs'
import { CredentialStore } from '../src/credentials.mjs'
import { APIError } from '../src/http.mjs'

const account = '11111111-1111-4111-8111-111111111111', grant = '22222222-2222-4222-8222-222222222222'
function tokens(letter = 'a') { return { account_id: account, grant_id: grant, access_token: `paa1_${letter.repeat(43)}`, refresh_token: `par1_${letter.repeat(43)}`, token_type: 'Bearer', scopes: ['tasks:read'], access_expires_at: Math.floor(Date.now() / 1000) + 900, expires_at: Math.floor(Date.now() / 1000) + 86400 } }
function refreshOnly(value = tokens()) { const { access_token: _token, access_expires_at: _expires, ...result } = value; return result }
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-agent-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return new CredentialStore({ directory, server: 'https://pipa.test', profile: 'test' })
}

test('access and refresh caches are private in auth.json; config and metadata expose neither', async (t) => {
  const store = await fixture(t), value = tokens()
  await store.withLock(() => store.save(value))
  const stored = await readFile(store.file, 'utf8'), config = await readFile(store.configFile, 'utf8')
  assert.ok(stored.includes(value.access_token)); assert.ok(stored.includes(value.refresh_token))
  assert.ok(!config.includes(value.access_token)); assert.ok(!config.includes(value.refresh_token))
  assert.ok(!JSON.stringify(await store.metadata()).includes(value.refresh_token))
  const restarted = new CredentialStore({ directory: store.directory, server: store.server, profile: store.profile })
  assert.equal((await restarted.credential(await restarted.metadata())).refresh_token, value.refresh_token)
  assert.equal((await store.credential(await store.metadata())).refresh_token, value.refresh_token)
  await store.forget(await store.metadata()); assert.equal(await store.credential(await store.metadata()), null)
})

test('two sessions share a single refresh and reread the new access cache', async (t) => {
  const store = await fixture(t); await store.save(refreshOnly())
  const used = []
  const request = async (_origin, route, { body }) => {
    if (route === '/help') return {}
    assert.equal(route, '/token'); used.push(body.refresh_token)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return tokens(used.length === 1 ? 'b' : 'c')
  }
  const a = new AuthSession({ server: store.server, store, request }), b = new AuthSession({ server: store.server, store, request })
  await Promise.all([a.accessToken(), b.accessToken()])
  assert.deepEqual(used, [tokens('a').refresh_token])
})

test('an unexpected refresh transport failure keeps the shared login', async (t) => {
  const store = await fixture(t); await store.save(refreshOnly())
  let calls = 0
  const auth = new AuthSession({ server: store.server, store, request: async (_origin, route) => {
    if (route === '/help') return {}
    calls++; throw new Error('lost response')
  } })
  await assert.rejects(auth.accessToken(), /credential_unavailable/)
  assert.equal(calls, 1); assert.ok(await store.credential(await store.metadata()))
})

test('storage failure happens before asking the user to authorize', async () => {
  let requests = 0
  const store = { metadata: async () => null, credential: async () => null, withLock: async () => { throw new Error('permissions unavailable') } }
  const auth = new AuthSession({ server: 'https://pipa.test', store, request: async () => { requests++ } })
  await assert.rejects(auth.begin(), /permissions unavailable/)
  assert.equal(requests, 0)
})

test('connect defaults to complete task and note access, while explicit scopes stay unchanged', async (t) => {
  const store = await fixture(t), requests = []
  const auth = new AuthSession({ server: store.server, store, request: async (_origin, route, options) => {
    assert.equal(route, '/device'); requests.push(options.body.scopes)
    throw new Error('stop before polling')
  } })
  await assert.rejects(auth.begin(), /stop before polling/)
  assert.deepEqual(requests[0], ['tasks:read', 'tasks:write', 'tasks:delete', 'notes:read', 'notes:write', 'notes:delete'])
  const requested = Object.freeze(['tasks:read', 'notes:read'])
  await assert.rejects(auth.begin(requested), /stop before polling/)
  assert.deepEqual(requests[1], requested)
  assert.equal(await store.metadata(), null)
})

test('complete-access default never silently upgrades an existing read-only connection', async (t) => {
  const store = await fixture(t); await store.save(tokens())
  let requests = 0
  const auth = new AuthSession({ server: store.server, store, request: async () => { requests++ } })
  await assert.rejects(auth.begin(), /already_connected/)
  assert.equal(requests, 0)
  assert.deepEqual((await auth.status()).scopes, ['tasks:read'])
})

test('empty, duplicate and unknown scopes cannot become complete-access requests', async (t) => {
  const store = await fixture(t)
  let requests = 0
  const auth = new AuthSession({ server: store.server, store, request: async () => { requests++ } })
  for (const requested of [[], ['tasks:read', 'tasks:read'], ['admin'], null]) {
    await assert.rejects(auth.begin(requested), /invalid_scopes/)
  }
  assert.equal(requests, 0)
})

test('token response validates identity and seconds before storage', () => {
  assert.equal(validateTokens(tokens()).account_id, account)
  const yearExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  assert.equal(validateTokens({ ...tokens(), expires_at: yearExpiry }).expires_at, yearExpiry)
  assert.throws(() => validateTokens({ ...tokens(), account_id: 'bad' }), /invalid_token_response/)
  assert.throws(() => validateTokens({ ...tokens(), scopes: ['admin'] }), /invalid_token_response/)
  assert.throws(() => validateTokens({ ...tokens(), access_expires_at: Date.now(), expires_at: Date.now() + 100000 }), /invalid_token_response/)
})

test('device flow returns no device secret, stores tokens only after approval, then notifies', async (t) => {
  const store = await fixture(t)
  let finish
  const changed = new Promise((resolve) => { finish = resolve })
  let polls = 0
  const auth = new AuthSession({ server: store.server, store, sleep: async () => {}, onChange: finish, request: async (_origin, route) => {
    if (route === '/device') return { device_code: `pad1_${'d'.repeat(43)}`, user_code: 'ABCDEFG234567', verification_uri_complete: 'https://pipa.test/agent/authorize#code=ABCDEFG234567', expires_at: Math.floor(Date.now() / 1000) + 600, interval: 5 }
    polls++; return tokens('d')
  } })
  const result = await auth.begin()
  assert.equal(result.device_code, undefined); assert.equal(result.refresh_token, undefined)
  await changed
  assert.equal(polls, 1); assert.equal((await auth.status()).state, 'connected')
  assert.equal(auth.pending, null)
})

test('local presence is unverified; expiry defeats even a cached access token and allows reconnect', async (t) => {
  const store = await fixture(t), value = tokens()
  await store.save(value)
  let calls = 0
  const auth = new AuthSession({ server: store.server, store, request: async () => { calls++; throw new APIError('stop_before_pairing') } })
  assert.equal((await auth.status()).state, 'unverified')
  await store.save({ ...refreshOnly(value), expires_at: 1 })
  auth.access = value
  assert.equal((await auth.status()).state, 'expired')
  await assert.rejects(auth.accessToken(), { code: 'authorization_expired' })
  assert.equal(calls, 0); assert.equal(await store.metadata(), null)
  await assert.rejects(auth.accessToken(), { code: 'authorization_expired' })
  assert.equal((await auth.status()).expires_at, 1)
  await assert.rejects(auth.begin(), { code: 'stop_before_pairing' })
  assert.equal(calls, 1)
})

test('transient business failure and gateway blocks retain credentials and recover without pairing', async (t) => {
  const store = await fixture(t), value = tokens()
  await store.save(value)
  const auth = new AuthSession({ server: store.server, store }); auth.access = value
  await auth.verified(value.access_token)
  for (const [error, state] of [[new APIError('network_error'), 'offline'],
    [new APIError('gateway_login_or_non_json: challenge', 401), 'blocked']]) {
    await auth.failed(error)
    assert.equal((await auth.status()).state, state)
    assert.equal((await auth.status()).reconnect_required, false)
    assert.equal((await store.credential(await store.metadata())).refresh_token, value.refresh_token)
    await auth.verified(value.access_token)
    assert.equal((await auth.status()).state, 'connected')
  }
  await auth.failed(new APIError('insufficient_scope', 403))
  assert.equal((await auth.status()).state, 'connected')
})

test('only confirmed invalid authorization clears login; refresh network failure retries once and retains it', async (t) => {
  for (const [failure, state, code] of [[new APIError('authorization_expired', 401), 'expired', 'authorization_expired'],
    [new APIError('authorization_revoked', 401), 'revoked', 'authorization_revoked'],
    [new APIError('invalid_grant', 401), 'reconnect_required', 'authorization_invalid'],
    [new APIError('network_error'), 'offline', 'refresh_unavailable']]) {
    const store = await fixture(t), value = tokens(); await store.save(refreshOnly(value))
    let calls = 0
    const auth = new AuthSession({ server: store.server, store, sleep: async () => {}, request: async (_origin, route) => {
      if (route === '/help') return {}
      calls++; throw failure
    } })
    await assert.rejects(auth.accessToken(), { code })
    await assert.rejects(auth.accessToken(), { code })
    const status = await auth.status()
    const offline = failure.code === 'network_error'
    assert.equal(status.state, state); assert.equal(status.reconnect_required, !offline)
    assert.equal(status.next_action, offline ? 'retry_later' : 'pipa_connect'); assert.equal(status.expires_at, value.expires_at)
    assert.equal(calls, offline ? 4 : 1); assert.equal(Boolean(await store.metadata()), offline)
    assert.ok(!JSON.stringify(status).includes(value.refresh_token))
  }
})

test('closing during device exchange cannot silently save a new login', async (t) => {
  const store = await fixture(t)
  let finish, deliver, requested, revocations = 0
  const changed = new Promise((resolve) => { finish = resolve })
  const tokenRequested = new Promise((resolve) => { requested = resolve })
  const auth = new AuthSession({ server: store.server, store, sleep: async () => {}, onChange: finish, request: async (_origin, route) => {
    if (route === '/device') return { device_code: `pad1_${'d'.repeat(43)}`, user_code: 'ABCDEFG234567', verification_uri_complete: 'https://pipa.test/agent/authorize#code=ABCDEFG234567', expires_at: Math.floor(Date.now() / 1000) + 600, interval: 5 }
    if (route === '/logout') { revocations++; return { revoked: true } }
    requested(); return new Promise((resolve) => { deliver = resolve })
  } })
  await auth.begin(); await tokenRequested
  auth.close(); deliver(tokens('e')); await changed
  assert.equal(auth.access, null); assert.equal(await store.metadata(), null)
  assert.equal(revocations, 1)
})

test('late auth failure for an old grant cannot delete a replacement connection', async (t) => {
  const store = await fixture(t), original = tokens()
  await store.save(original)
  const auth = new AuthSession({ server: store.server, store }); auth.access = original
  const replacement = { ...tokens('b'), grant_id: '33333333-3333-4333-8333-333333333333' }
  await store.save(replacement)
  assert.equal(await auth.failed(new APIError('authorization_revoked', 401, 0, original.grant_id)), false)
  assert.equal((await store.metadata()).grant_id, replacement.grant_id)
  assert.equal((await auth.status()).state, 'unverified')
})

test('network refresh failure never attempts to remove a credential even if cleanup is unavailable', async (t) => {
  const store = await fixture(t), value = tokens(); await store.save(refreshOnly(value))
  const unavailableCleanup = {
    metadata: () => store.metadata(), credential: (meta) => store.credential(meta),
    withLock: (run) => store.withLock(run), forget: async () => { throw new Error('file unavailable') },
  }
  let calls = 0
  const auth = new AuthSession({ server: store.server, store: unavailableCleanup, sleep: async () => {}, request: async () => { calls++; throw new APIError('network_error') } })
  await assert.rejects(auth.accessToken(), { code: 'refresh_unavailable' })
  assert.equal(calls, 2); assert.equal((await auth.status()).state, 'offline')
  assert.ok(await store.metadata())
})

test('cancellation before refresh starts does not discard an unconsumed credential', async (t) => {
  const store = await fixture(t); await store.save(tokens())
  let calls = 0
  const auth = new AuthSession({ server: store.server, store, request: async () => { calls++ } })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(auth.accessToken(controller.signal), { code: 'request_cancelled' })
  assert.equal(calls, 0); assert.ok(await store.metadata())
})

test('a sibling disconnect cannot leave local status reporting connected, and pairing failures survive rediscovery', async (t) => {
  const store = await fixture(t), value = tokens(); await store.save(value)
  const auth = new AuthSession({ server: store.server, store }); auth.access = value
  await auth.verified(value.access_token)
  await store.forget(await store.metadata())
  assert.equal((await auth.status()).state, 'signed_out')
  await auth.failed(new APIError('authorization_required', 401))
  assert.equal((await auth.status()).state, 'signed_out')
  for (const code of ['authorization_denied', 'pairing_expired']) {
    auth.connection = { code }
    await auth.failed(new APIError('authorization_required', 401))
    assert.equal((await auth.status()).code, code)
  }
})
