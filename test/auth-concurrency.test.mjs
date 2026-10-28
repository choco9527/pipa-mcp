import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuthSession } from '../src/auth.mjs'
import { CredentialStore } from '../src/credentials.mjs'
import { APIError } from '../src/http.mjs'

const account = '11111111-1111-4111-8111-111111111111'
const oldGrant = '22222222-2222-4222-8222-222222222222'
const newGrant = '33333333-3333-4333-8333-333333333333'
function tokens(letter, grant = oldGrant) {
  const now = Math.floor(Date.now() / 1000)
  return { account_id: account, grant_id: grant, token_type: 'Bearer',
    access_token: `paa1_${letter.repeat(43)}`, refresh_token: `par1_${letter.repeat(43)}`,
    scopes: ['tasks:read'], access_expires_at: now + 900, expires_at: now + 86400 }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-auth-concurrency-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return new CredentialStore({ directory, server: 'https://pipa.test', profile: 'test' })
}

test('disconnect cannot revoke a replacement grant created by another process', async (t) => {
  const store = await fixture(t), old = tokens('a'), replacement = tokens('b', newGrant)
  await store.withLock(() => store.save(old))
  let lockHeld = false, replacementTask, replaced = false, revoked
  const concurrentStore = {
    metadata: () => store.metadata(),
    async credential(meta) {
      const value = await store.credential(meta)
      if (!replaced && meta?.grant_id === oldGrant) {
        replaced = true
        const replace = () => store.withLock(() => store.save(replacement))
        if (lockHeld) replacementTask = replace()
        else { replacementTask = replace(); await replacementTask }
      }
      return value
    },
    withLock: (run) => store.withLock(async (guard) => {
      lockHeld = true
      try { return await run(guard) } finally { lockHeld = false }
    }),
    save: (value) => store.save(value),
    forget: (meta) => store.forget(meta),
  }
  const auth = new AuthSession({ server: store.server, store: concurrentStore,
    request: async (_origin, route, options) => {
      if (route === '/token') return replacement
      if (route === '/logout') {
        revoked = options.token === old.access_token ? oldGrant : newGrant
        return { revoked: true }
      }
      throw new Error('unexpected request')
    } })
  auth.access = old
  await auth.disconnect()
  await replacementTask
  assert.equal(revoked, oldGrant, 'logout must use only the grant that was selected at disconnect start')
  assert.equal((await store.metadata())?.grant_id, newGrant, 'a replacement grant must remain available')
})

test('a Cloudflare HTML 401 during logout cannot discard a usable credential', async (t) => {
  const store = await fixture(t), value = tokens('a')
  await store.withLock(() => store.save(value))
  const auth = new AuthSession({ server: store.server, store,
    request: async () => { throw new APIError('gateway_login_or_non_json: challenge', 401) } })
  auth.access = value
  await assert.rejects(auth.disconnect(), (error) => error.code?.split(':', 1)[0] === 'remote_revoke_failed')
  assert.equal((await store.metadata())?.grant_id, oldGrant)
  assert.ok(await store.credential(await store.metadata()))
})

test('logout retries only a confirmed expired access token, once', async (t) => {
  const store = await fixture(t), original = tokens('a'), refreshed = tokens('b')
  await store.withLock(() => store.save(original))
  let logouts = 0, refreshes = 0
  const auth = new AuthSession({ server: store.server, store, request: async (_origin, route) => {
    if (route === '/help') return {}
    if (route === '/token') { refreshes++; return refreshed }
    if (route === '/logout' && ++logouts === 1) throw new APIError('access_token_expired', 401)
    if (route === '/logout') return { revoked: true }
    throw new Error('unexpected request')
  } })
  auth.access = original
  const result = await auth.disconnect()
  assert.equal(result.revoked, true)
  assert.equal(logouts, 2); assert.equal(refreshes, 1)
  assert.equal(await store.metadata(), null)
})

test('another process reuses live access without consuming any refresh token', async (t) => {
  const store = await fixture(t), original = tokens('a'), first = tokens('b'), second = tokens('c')
  await store.withLock(() => store.save(original))
  let refreshes = 0
  const request = async (_origin, route) => {
    assert.equal(route, '/token')
    return ++refreshes === 1 ? first : second
  }
  const a = new AuthSession({ server: store.server, store, request })
  const b = new AuthSession({ server: store.server, store, request })
  assert.equal(await a.accessToken(), original.access_token)
  assert.equal(await b.accessToken(), original.access_token)
  assert.equal(await a.accessToken(), original.access_token)
  assert.equal(refreshes, 0)
})

function accessFailure(code, identity) {
  const error = new APIError(code, 401, 0, identity?.grantId)
  Object.defineProperty(error, 'pipaAccessResponse', { value: true })
  if (identity?.credentialGeneration) {
    Object.defineProperty(error, 'credentialGeneration', { value: identity.credentialGeneration })
  }
  return error
}

test('a stale access rejection cannot clear a sibling process newer refresh credential', async (t) => {
  const store = await fixture(t), original = tokens('a'), rotated = tokens('b'), next = tokens('c')
  await store.withLock(() => store.save(original))
  let refreshes = 0
  const auth = new AuthSession({ server: store.server, store, request: async (_origin, route) => {
    assert.equal(route, '/token'); refreshes++; return next
  } })
  auth.access = original
  const identity = auth.requestIdentity(original.access_token)
  await store.withLock(() => store.save(rotated))
  assert.equal(await auth.failed(accessFailure('invalid_grant', identity)), false)
  assert.equal((await store.credential(await store.metadata()))?.refresh_token, rotated.refresh_token)
  assert.equal(auth.access, null)
  assert.equal((await auth.status()).state, 'unverified')
  assert.equal(await auth.accessToken(), rotated.access_token)
  assert.equal(refreshes, 0)
})

test('an ambiguous access 401 retains a matching refresh and never retries on its own', async (t) => {
  const store = await fixture(t), original = tokens('a')
  await store.withLock(() => store.save(original))
  let requests = 0
  const auth = new AuthSession({ server: store.server, store, request: async () => { requests++; return tokens('b') } })
  auth.access = original
  const error = accessFailure('unauthorized', auth.requestIdentity(original.access_token))
  assert.equal(await auth.failed(error), false)
  assert.equal(await auth.failed(error), false)
  assert.equal((await store.credential(await store.metadata()))?.refresh_token, original.refresh_token)
  assert.equal(auth.access, null)
  assert.equal((await auth.status()).state, 'unverified')
  assert.equal(requests, 0)
  assert.ok(!JSON.stringify(error).includes(original.refresh_token))
})

test('confirmed grant revocation still clears rotated credentials of the same grant', async (t) => {
  const store = await fixture(t), original = tokens('a'), rotated = tokens('b')
  await store.withLock(() => store.save(original))
  const auth = new AuthSession({ server: store.server, store }); auth.access = original
  const identity = auth.requestIdentity(original.access_token)
  await store.withLock(() => store.save(rotated))
  await auth.failed(accessFailure('authorization_revoked', identity))
  assert.equal(await store.metadata(), null)
  assert.equal((await auth.status()).state, 'revoked')
})

test('a late old access error does not downgrade a newer verified in-memory token', async (t) => {
  const store = await fixture(t), original = tokens('a'), rotated = tokens('b')
  await store.withLock(() => store.save(original))
  const auth = new AuthSession({ server: store.server, store }); auth.access = original
  const identity = auth.requestIdentity(original.access_token)
  await store.withLock(() => store.save(rotated))
  auth.access = rotated; await auth.verified(rotated.access_token)
  assert.equal(await auth.failed(accessFailure('invalid_grant', identity)), false)
  assert.equal(auth.access.access_token, rotated.access_token)
  assert.equal((await auth.status()).state, 'connected')
})

test('a replacement grant appearing before logout lock is never revoked', async (t) => {
  const store = await fixture(t), original = tokens('a'), replacement = tokens('b', newGrant)
  await store.withLock(() => store.save(original))
  let replaced = false, requests = 0
  const concurrentStore = {
    async metadata() {
      const old = await store.metadata()
      if (!replaced) { replaced = true; await store.withLock(() => store.save(replacement)) }
      return old
    },
    credential: (meta) => store.credential(meta), withLock: (run) => store.withLock(run),
    save: (value) => store.save(value), forget: (meta) => store.forget(meta),
  }
  const auth = new AuthSession({ server: store.server, store: concurrentStore, request: async () => { requests++ } })
  await assert.rejects(auth.disconnect(), (error) => error.code?.split(':', 1)[0] === 'profile_changed')
  assert.equal(requests, 0)
  assert.equal((await store.metadata())?.grant_id, newGrant)
})

test('an ambiguous 401 or invalid logout response retains the credential', async (t) => {
  for (const failure of [new APIError('invalid_grant', 401), new APIError('unauthorized', 401), null]) {
    const store = await fixture(t), value = tokens('a')
    await store.withLock(() => store.save(value))
    const auth = new AuthSession({ server: store.server, store, request: async () => {
      if (failure) throw failure
      return { revoked: false }
    } })
    auth.access = value
    await assert.rejects(auth.disconnect(), (error) => error.code?.split(':', 1)[0] === 'remote_revoke_failed')
    assert.equal((await store.metadata())?.grant_id, oldGrant)
  }
})

test('confirmed expired or revoked grants can be cleaned without another authorization', async (t) => {
  for (const code of ['authorization_expired', 'authorization_revoked']) {
    const store = await fixture(t), value = tokens('a')
    await store.withLock(() => store.save(value))
    const auth = new AuthSession({ server: store.server, store, request: async () => { throw new APIError(code, 401) } })
    auth.access = value
    const result = await auth.disconnect()
    assert.equal(result.disconnected, true); assert.equal(result.revoked, false)
    assert.equal(await store.metadata(), null)
  }
})

test('a refresh response from another grant cannot cause that grant to be revoked', async (t) => {
  const store = await fixture(t), original = tokens('a'), unexpected = tokens('b', newGrant)
  await store.withLock(() => store.save(original))
  let logouts = 0
  const auth = new AuthSession({ server: store.server, store, request: async (_origin, route) => {
    if (route === '/help') return {}
    if (route === '/token') return unexpected
    if (route === '/logout') { logouts++; return { revoked: true } }
    throw new Error('unexpected request')
  } })
  await auth.rejectAccess(original.access_token)
  await assert.rejects(auth.accessToken(), { code: 'credential_identity_changed' })
  assert.equal(logouts, 0)
  assert.ok(await store.metadata())
})
