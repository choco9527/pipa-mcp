import path from 'node:path'
import lockfile from 'proper-lockfile'
import { platformDirectory, profileKey } from './options.mjs'
import { PrivateFiles } from './private-files.mjs'

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const scopes = ['tasks:read', 'tasks:write', 'tasks:delete', 'notes:read', 'notes:write', 'notes:delete']
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Plaintext storage is intentional. Access tokens remain memory-only. Every
// update is performed under the shared file lock and committed by atomic rename.
export class CredentialStore {
  constructor({ server, profile, directory = platformDirectory(), files = new PrivateFiles(directory) }) {
    this.server = server; this.profile = profile; this.directory = directory; this.files = files
    this.key = profileKey(server, profile)
    this.file = path.join(directory, 'auth.json'); this.configFile = path.join(directory, 'config.json')
  }
  async prepare() { await this.files.prepare() }
  async withLock(run) {
    await this.prepare()
    let compromised = false
    const release = await lockfile.lock(this.directory, {
      lockfilePath: `${this.file}.lock`, stale: 60000, update: 10000,
      retries: { retries: 40, minTimeout: 100, maxTimeout: 500, factor: 1.2 },
      onCompromised: () => { compromised = true },
    })
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
    return { account_id: data.account_id, grant_id: data.grant_id, refresh_token: data.refresh_token }
  }
  async save(tokens) {
    if (!validCredential(tokens)) throw new Error('invalid_credential_response')
    const data = { server: this.server, profile: this.profile, ...metadata(tokens), refresh_token: tokens.refresh_token }
    const config = await this.document('config.json')
    await this.files.write('config.json', { ...config, profiles: { ...config.profiles, [this.key]: { server: this.server, profile: this.profile } } })
    const auth = await this.document('auth.json')
    await this.files.write('auth.json', { ...auth, profiles: { ...auth.profiles, [this.key]: data } })
    return metadata(data)
  }
  async forget(meta) {
    if (!meta) return
    const auth = await this.document('auth.json'), current = auth.profiles[this.key]
    if (!current || current.account_id !== meta.account_id || current.grant_id !== meta.grant_id) return
    const profiles = Object.fromEntries(Object.entries(auth.profiles).filter(([key]) => key !== this.key))
    await this.files.write('auth.json', { ...auth, profiles })
  }
}

function metadata(value) {
  return { account_id: value.account_id, grant_id: value.grant_id, expires_at: value.expires_at, scopes: [...value.scopes] }
}
function validCredential(value) {
  return record(value) && uuid.test(value.account_id) && uuid.test(value.grant_id) && /^par1_[\w-]{43}$/.test(value.refresh_token)
    && Number.isSafeInteger(value.expires_at) && value.expires_at > 0 && value.expires_at <= 253402300799
    && Array.isArray(value.scopes) && value.scopes.length > 0 && new Set(value.scopes).size === value.scopes.length
    && value.scopes.every((scope) => scopes.includes(scope))
}
