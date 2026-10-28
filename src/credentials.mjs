import path from 'node:path'
import lockfile from 'proper-lockfile'
import { setTimeout as delay } from 'node:timers/promises'
import { APIError } from './http.mjs'
import { platformDirectory, profileKey } from './options.mjs'
import { PrivateFiles } from './private-files.mjs'

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const scopes = ['tasks:read', 'tasks:write', 'tasks:delete', 'notes:read', 'notes:write', 'notes:delete']
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Both rotating refresh credentials and short-lived access caches are private
// plaintext. Updates use the shared file lock and an atomic file replacement.
export class CredentialStore {
  constructor({ server, profile, directory = platformDirectory(), files = new PrivateFiles(directory) }) {
    this.server = server; this.profile = profile; this.directory = directory; this.files = files
    this.key = profileKey(server, profile)
    this.file = path.join(directory, 'auth.json'); this.configFile = path.join(directory, 'config.json')
  }
  async prepare() { await this.files.prepare() }
  async withLock(run, { signal } = {}) {
    await this.prepare()
    let compromised = false
    const release = await acquireLock(this.directory, this.file, () => { compromised = true }, signal)
    try { return await run(() => { if (compromised) throw new Error('credential_lock_lost: reconnect before retrying') }) }
    finally { await release().catch(() => {}) }
  }
  async document(name) {
    const data = await this.files.read(name)
    if (!record(data) || data.version !== 1 || !record(data.profiles)) throw new Error('invalid_credential_file: reconnect or restore a valid private file')
    return data
  }
  async stored() {
    const data = (await this.document('auth.json')).profiles[this.key]
    if (data === undefined) return null
    if (!validCredential(data) || data.server !== this.server || data.profile !== this.profile) throw new Error('invalid_credential_file: reconnect without sharing its contents')
    return data
  }
  async metadata() {
    const data = await this.stored()
    return data ? metadata(data) : null
  }
  async credential(meta) {
    if (!meta) return null
    const data = await this.stored()
    if (!data || data.account_id !== meta.account_id || data.grant_id !== meta.grant_id) return null
    return { ...metadata(data), refresh_token: data.refresh_token, ...privateCache(data) }
  }
  async save(tokens) {
    if (!validCredential(tokens)) throw new Error('invalid_credential_response')
    const data = { server: this.server, profile: this.profile, ...metadata(tokens), refresh_token: tokens.refresh_token, ...privateCache(tokens) }
    const config = await this.document('config.json')
    await this.files.write('config.json', { ...config, profiles: { ...config.profiles, [this.key]: { server: this.server, profile: this.profile } } })
    const auth = await this.document('auth.json')
    await this.files.write('auth.json', { ...auth, profiles: { ...auth.profiles, [this.key]: data } })
    return metadata(data)
  }
  async invalidateAccess(meta, token) {
    const auth = await this.document('auth.json'), current = auth.profiles[this.key]
    if (!current || current.grant_id !== meta?.grant_id || current.account_id !== meta?.account_id || current.access_token !== token) return
    const { access_token: _token, access_expires_at: _expires, ...data } = current
    await this.files.write('auth.json', { ...auth, profiles: { ...auth.profiles, [this.key]: data } })
  }
  async cachedCatalog(meta) {
    const item = (await this.document('tools.json')).profiles[this.key]
    if (!item || item.grant_id !== meta?.grant_id || item.account_id !== meta?.account_id
      || JSON.stringify(item.scopes) !== JSON.stringify(meta?.scopes) || !Number.isSafeInteger(item.expires_at)
      || item.expires_at <= Date.now() / 1000 || item.expires_at > Date.now() / 1000 + 310) return null
    return { tools: item.tools, expires_at: item.expires_at }
  }
  async cacheCatalog(meta, tools) {
    return this.withLock(async (guard) => {
      const current = await this.metadata()
      if (!current || current.grant_id !== meta?.grant_id || current.account_id !== meta?.account_id
        || JSON.stringify(current.scopes) !== JSON.stringify(meta?.scopes)) return
      const document = await this.document('tools.json')
      const value = { ...metadata(current), expires_at: Math.floor(Date.now() / 1000) + 300, tools: structuredClone(tools) }
      guard(); await this.files.write('tools.json', { ...document, profiles: { ...document.profiles, [this.key]: value } })
    })
  }
  async forget(meta) {
    if (!meta) return
    const auth = await this.document('auth.json'), current = auth.profiles[this.key]
    if (!current || current.account_id !== meta.account_id || current.grant_id !== meta.grant_id) return
    const profiles = Object.fromEntries(Object.entries(auth.profiles).filter(([key]) => key !== this.key))
    await this.files.write('auth.json', { ...auth, profiles })
  }
}

async function acquireLock(directory, file, onCompromised, signal) {
  const until = Date.now() + 35000
  for (;;) {
    if (signal?.aborted) throw new APIError('request_cancelled')
    try { return await lockfile.lock(directory, { lockfilePath: `${file}.lock`, stale: 60000, update: 10000, retries: 0, onCompromised }) }
    catch (error) {
      if (error.code !== 'ELOCKED' || Date.now() >= until) throw error
      try { await delay(100, undefined, { signal }) }
      catch { throw new APIError('request_cancelled') }
    }
  }
}

function metadata(value) {
  return { account_id: value.account_id, grant_id: value.grant_id, expires_at: value.expires_at, scopes: [...value.scopes] }
}
function validCredential(value) {
  return record(value) && uuid.test(value.account_id) && uuid.test(value.grant_id) && /^par1_[\w-]{43}$/.test(value.refresh_token)
    && Number.isSafeInteger(value.expires_at) && value.expires_at > 0 && value.expires_at <= 253402300799
    && Array.isArray(value.scopes) && value.scopes.length > 0 && new Set(value.scopes).size === value.scopes.length
    && value.scopes.every((scope) => scopes.includes(scope)) && validCache(value)
}
function privateCache(value) {
  return value.access_token === undefined ? {} : { access_token: value.access_token, access_expires_at: value.access_expires_at }
}
function validCache(value) {
  return (value.access_token === undefined && value.access_expires_at === undefined
    || /^paa1_[\w-]{43}$/.test(value.access_token) && Number.isSafeInteger(value.access_expires_at)
      && value.access_expires_at > 0 && value.access_expires_at <= value.expires_at)
}
