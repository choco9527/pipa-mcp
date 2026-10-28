import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { APIError, requestJSON } from './http.mjs'
import { authorizationFailure, connectionFailure, describeConnection } from './connection-state.mjs'

export const scopes = ['tasks:read', 'tasks:write', 'tasks:delete', 'notes:read', 'notes:write', 'notes:delete']
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const generation = (value) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : undefined
const sameGrant = (a, b) => a?.account_id === b?.account_id && a?.grant_id === b?.grant_id
const ambiguousAccess = (error) => error?.pipaAccessResponse === true
  && ['invalid_grant', 'unauthorized', 'authorization_invalid', 'access_token_expired'].includes(error.code?.split(':', 1)[0])
export function validateTokens(value) {
  if (!value || !/^paa1_[\w-]{43}$/.test(value.access_token) || !/^par1_[\w-]{43}$/.test(value.refresh_token)
    || !uuid.test(value.account_id) || !uuid.test(value.grant_id) || value.token_type !== 'Bearer'
    || !Number.isSafeInteger(value.access_expires_at) || !Number.isSafeInteger(value.expires_at)
    || value.expires_at > 253402300799 || value.access_expires_at <= Date.now() / 1000
    || value.access_expires_at > value.expires_at || value.expires_at <= Date.now() / 1000
    || !Array.isArray(value.scopes) || !value.scopes.length || new Set(value.scopes).size !== value.scopes.length
    || value.scopes.some((scope) => !scopes.includes(scope))) throw new APIError('invalid_token_response')
  return value
}

export class AuthSession {
  constructor({ server, store, request = requestJSON, onChange = () => {}, sleep = delay }) {
    this.server = server; this.store = store; this.request = request; this.onChange = onChange; this.sleep = sleep
    this.access = null; this.pending = null; this.connection = null; this.refreshing = null
  }
  async status() {
    const meta = await this.store.metadata()
    const credential = await this.store.credential(meta)
    const remembered = this.connection && (!this.connection.meta || describeConnection(this.connection.code).reconnect_required)
    const recent = this.connection && (credential ? this.connection.meta?.grant_id === meta.grant_id : remembered) ? this.connection : null
    const code = this.pending ? 'authorization_pending' : credential && meta.expires_at <= Date.now() / 1000
      ? 'authorization_expired' : recent?.code ?? (credential ? 'not_verified' : 'authorization_required')
    const identity = credential ? meta : recent?.meta
    return { product: 'PIPA', server: this.server, ...describeConnection(code), account_id: identity?.account_id,
      grant_id: identity?.grant_id, scopes: identity?.scopes ?? [], expires_at: identity?.expires_at, checked_at: recent?.checked_at, cause: recent?.cause,
      expires_soon: Boolean(credential && meta.expires_at > Date.now() / 1000 && meta.expires_at <= Date.now() / 1000 + 7 * 86400),
      management_url: `${this.server}/agent/connections` }
  }
  async verified(token) {
    const meta = await this.store.metadata()
    if (meta && this.access?.access_token === token && this.access.grant_id === meta.grant_id) {
      this.connection = { code: 'connected', meta, checked_at: Math.floor(Date.now() / 1000) }
    }
  }
  requestIdentity(token) {
    if (!this.access || this.access.access_token !== token) return undefined
    return { grantId: this.access.grant_id, credentialGeneration: generation(this.access.refresh_token) }
  }
  async failed(error) {
    const code = connectionFailure(error)
    if (!code) return
    const meta = await this.store.metadata()
    if (error.grantId && meta?.grant_id !== error.grantId) return false
    // Preserve the precise reason after terminal credentials have been removed.
    if (!meta && this.connection && (code === this.connection.code || code === 'authorization_required'
      && (describeConnection(this.connection.code).reconnect_required || ['authorization_denied', 'pairing_expired'].includes(this.connection.code)))) return
    if (ambiguousAccess(error)) return this.failedAccess(error, meta)
    if (authorizationFailure(error) && !(await this.forgetFailedGrant(error, meta))) return false
    this.connection = { code, meta: meta ?? this.connection?.meta, checked_at: Math.floor(Date.now() / 1000) }
  }
  async failedAccess(error, expected) {
    return this.store.withLock(async (guard) => {
      const current = await this.store.metadata()
      if (!sameGrant(current, expected) || error.grantId && current?.grant_id !== error.grantId) return false
      const credential = await this.store.credential(current)
      if (!credential) return false
      guard()
      // A rejection of an access token does not prove the current refresh is invalid.
      // In particular a sibling may have rotated refresh while the old request was in flight.
      if (error.credentialGeneration && this.access?.refresh_token
        && generation(this.access.refresh_token) !== error.credentialGeneration) return false
      if (!error.credentialGeneration || generation(this.access?.refresh_token) === error.credentialGeneration) this.access = null
      this.connection = { code: 'not_verified', meta: current, checked_at: Math.floor(Date.now() / 1000) }
      return false // Keep the tool catalog; never replay the failed operation here.
    })
  }
  async forgetFailedGrant(error, expected) {
    return this.store.withLock(async (guard) => {
      const current = await this.store.metadata()
      if (!sameGrant(current, expected) || error.grantId && current?.grant_id !== error.grantId) return false
      guard(); await this.store.forget(current); this.access = null
      return true
    })
  }
  async begin(requested = [...scopes]) {
    if (!Array.isArray(requested) || !requested.length || requested.length > scopes.length || new Set(requested).size !== requested.length || requested.some((scope) => !scopes.includes(scope))) throw new APIError('invalid_scopes')
    if (this.pending) return this.pending.public
    await this.store.withLock(async (guard) => {
      const meta = await this.store.metadata()
      if (!(await this.store.credential(meta))) return
      const unusable = this.connection?.meta?.grant_id === meta.grant_id && describeConnection(this.connection.code).reconnect_required
      if (meta.expires_at > Date.now() / 1000 && !unusable) throw new APIError('already_connected: disconnect before changing account or permissions')
      guard(); await this.store.forget(meta); this.access = null
    })
    const meta = await this.store.metadata()
    // Verify owner-only storage can be prepared before asking for permission.
    await this.store.prepare()
    const device = await this.request(this.server, '/device', { method: 'POST', body: { device_name: `PIPA Agent (${hostname()})`.slice(0, 120), scopes: requested } })
    const publicResult = validateDevice(device)
    this.connection = null; const controller = new AbortController()
    this.pending = { controller, public: publicResult }
    void this.poll(device, meta?.grant_id, controller.signal).catch((error) => {
      if (!controller.signal.aborted) this.connection = { code: error.code === 'access_denied' ? 'authorization_denied'
        : error.code?.startsWith('expired_token') ? 'pairing_expired' : connectionFailure(error) ?? 'server_configuration_error' }
    }).finally(() => { if (this.pending?.controller === controller) this.pending = null; this.onChange() })
    return publicResult
  }
  async poll(device, expectedGrant, signal) {
    let interval = device.interval * 1000
    while (Date.now() / 1000 < device.expires_at && !signal.aborted) {
      await this.sleep(interval, undefined, { signal })
      let tokens
      try { tokens = validateTokens(await this.request(this.server, '/token', { method: 'POST', signal, body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code } })) }
      catch (error) {
        if (error.code === 'authorization_pending') continue
        if (error.code === 'slow_down' || error.status === 429) { interval = Math.min(60000, Math.max(interval + 5000, error.retryAfter || 0)); continue }
        throw error
      }
      try {
        await this.store.withLock(async (guard) => {
          signal.throwIfAborted()
          if ((await this.store.metadata())?.grant_id !== expectedGrant) throw new APIError('profile_changed: another Agent connected this profile')
          guard(); const saved = await this.store.save(tokens)
          if (signal.aborted) { await this.store.forget(saved); signal.throwIfAborted() }
          this.access = tokens
          this.connection = { code: 'connected', meta: saved, checked_at: Math.floor(Date.now() / 1000) }
        })
      } catch (error) {
        await this.request(this.server, '/logout', { method: 'POST', body: {}, token: tokens.access_token }).catch(() => {})
        throw error
      }
      return
    }
    throw new APIError('expired_token: start a new connection')
  }
  async accessToken(signal) {
    if (signal?.aborted) throw new APIError('request_cancelled')
    const meta = await this.store.metadata()
    if (meta && this.connection?.meta?.grant_id === meta.grant_id && describeConnection(this.connection.code).reconnect_required) throw new APIError(this.connection.code, 401)
    if (meta?.expires_at > Date.now() / 1000 && this.access && meta.grant_id === this.access.grant_id && this.access.access_expires_at > Date.now() / 1000 + 30) return this.access.access_token
    if (!this.refreshing) this.refreshing = this.refresh(signal).finally(() => { this.refreshing = null })
    return this.refreshing
  }
  async refresh(signal) {
    return this.store.withLock(async (guard) => {
      const meta = await this.store.metadata(), credential = await this.store.credential(meta)
      return this.refreshLocked(meta, credential, guard, signal)
    })
  }
  async refreshLocked(meta, credential, guard, signal) {
    if (!credential) throw new APIError(this.connection?.code && describeConnection(this.connection.code).reconnect_required ? this.connection.code : 'authorization_required', 401)
    if (meta.expires_at <= Date.now() / 1000) {
      guard(); await this.store.forget(meta); this.access = null
      this.connection = { code: 'authorization_expired', meta }
      throw new APIError('authorization_expired', 401)
    }
    if (signal?.aborted) throw new APIError('request_cancelled')
    guard()
    let tokens
    try {
      tokens = validateTokens(await this.request(this.server, '/token', { method: 'POST', signal, body: { grant_type: 'refresh_token', refresh_token: credential.refresh_token } }))
      if (tokens.account_id !== meta.account_id || tokens.grant_id !== meta.grant_id) throw new APIError('credential_identity_changed')
      guard(); const saved = await this.store.save(tokens); this.access = tokens
      this.connection = { code: 'connected', meta: saved, checked_at: Math.floor(Date.now() / 1000) }
      return tokens.access_token
    } catch (error) {
      // Never revoke an unexpected grant returned by a faulty or malicious server.
      if (tokens && sameGrant(tokens, meta)) {
        try { guard(); await this.request(this.server, '/logout', { method: 'POST', body: {}, token: tokens.access_token }) } catch {}
      }
      const code = authorizationFailure(error) ? connectionFailure(error) : 'refresh_result_uncertain'
      this.access = null
      this.connection = { code, meta, cause: connectionFailure(error) ?? 'invalid_refresh_response', checked_at: Math.floor(Date.now() / 1000) }
      try { guard(); await this.store.forget(meta) } catch {} // The in-memory latch still prevents reuse if cleanup cannot complete.
      throw new APIError(code, 401) // Never expose a transient status that business retry could replay as refresh.
    }
  }
  async disconnect(signal) {
    this.pending?.controller.abort(); this.pending = null
    if (signal?.aborted) throw new APIError('request_cancelled')
    const expected = await this.store.metadata()
    const result = await this.store.withLock(async (guard) => {
      const meta = await this.store.metadata()
      if (!meta) return { disconnected: true }
      if (!sameGrant(meta, expected)) throw new APIError('profile_changed: the connection changed; retry explicitly', 409)
      const credential = await this.store.credential(meta)
      if (!credential) throw new APIError('profile_changed: the connection changed; retry explicitly', 409)
      const revoked = await this.revokeLocked(meta, credential, guard, signal)
      guard(); await this.store.forget(meta)
      return { disconnected: true, revoked, message: revoked ? 'Server grant revoked and local credential deleted.' : 'Grant was already expired or revoked; local credential deleted.' }
    })
    this.access = null; this.connection = null; this.onChange()
    return result
  }
  async revokeLocked(meta, credential, guard, signal) {
    const cached = this.access && sameGrant(meta, this.access) && this.access.access_expires_at > Date.now() / 1000 + 30
    let token
    try { token = cached ? this.access.access_token : await this.refreshLocked(meta, credential, guard, signal) }
    catch (error) {
      if (['authorization_expired', 'authorization_revoked'].includes(error.code)) return false
      throw error
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        guard()
        const result = await this.request(this.server, '/logout', { method: 'POST', body: {}, token, signal })
        if (result?.revoked !== true) throw new APIError('invalid_server_response')
        return true
      } catch (error) {
        if (error.code === 'access_token_expired' && error.status === 401 && attempt === 0) {
          this.access = null
          token = await this.refreshLocked(meta, await this.store.credential(meta), guard, signal)
          continue
        }
        if (error.status === 401 && ['authorization_expired', 'authorization_revoked'].includes(error.code)) return false
        throw new APIError('remote_revoke_failed: retry disconnect or revoke in the PIPA website; credential retained')
      }
    }
  }
  close() { this.pending?.controller.abort(); this.pending = null; this.access = null }
}

function validateDevice(device) {
  let uri
  try { uri = new URL(device.verification_uri_complete) } catch { throw new APIError('invalid_authorization_response') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)
  if (!(uri.protocol === 'https:' || uri.protocol === 'http:' && local) || uri.username || uri.password || uri.pathname !== '/agent/authorize'
    || !/^pad1_[\w-]{43}$/.test(device.device_code) || !/^[A-Z2-7]{13}$/.test(device.user_code)
    || uri.search || uri.hash !== `#code=${device.user_code}` || !Number.isSafeInteger(device.expires_at) || device.expires_at <= Date.now() / 1000 || device.expires_at > Date.now() / 1000 + 660
    || !Number.isSafeInteger(device.interval) || device.interval < 5 || device.interval > 60) throw new APIError('invalid_authorization_response')
  return { state: 'awaiting_user', verification_uri: uri.toString(), user_code: device.user_code, expires_at: device.expires_at,
    message: 'User: personally open this link, verify the domain and pairing code, log in, review the requested access and confirm the connection. Do not ask the Agent to approve for you. Then use pipa_connection_status.' }
}
