import { ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { APIError, requestJSON, retryOnce } from './http.mjs'
import { authorizationFailure, describeConnection, expiryNotice } from './connection-state.mjs'

const localNames = new Set(['pipa_about', 'pipa_connect', 'pipa_connection_status', 'pipa_disconnect'])
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const toolName = /^pipa_[a-z0-9_]{1,100}$/
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateCatalog(result) {
  if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > 200) throw new APIError('invalid_tool_catalog')
  const names = new Set()
  return result.tools.map((tool) => {
    let parsed
    try { parsed = ToolSchema.parse(tool) } catch { throw new APIError('invalid_tool_catalog') }
    if (!toolName.test(parsed.name) || localNames.has(parsed.name) || names.has(parsed.name)
      || typeof tool.mutation !== 'boolean' || typeof tool.destructive !== 'boolean') throw new APIError('invalid_tool_catalog')
    names.add(parsed.name)
    return { ...parsed, mutation: tool.mutation, destructive: tool.destructive }
  })
}

function snapshotArguments(args) {
  if (!isRecord(args)) throw new APIError('invalid_arguments')
  try {
    const text = JSON.stringify(args, (_key, value) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid JSON value')
      return value
    })
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('arguments too large')
    return JSON.parse(text)
  } catch { throw new APIError('invalid_arguments') }
}

/** Plain HTTP client shared by CLI and MCP; it never starts an MCP server or reads credentials itself. */
export class PipaClient {
  constructor({ server, auth, request = requestJSON }) {
    this.origin = server; this.auth = auth; this.request = request; this.tools = null; this.failures = new WeakSet()
  }

  async authorized(route, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken(options.signal)
      const identity = this.auth.requestIdentity?.(token)
        ?? { grantId: this.auth.access?.access_token === token ? this.auth.access.grant_id : undefined }
      try {
        const result = await this.request(this.origin, route, { ...options, token })
        await this.auth.verified?.(token).catch(() => {})
        return result
      } catch (error) {
        // Only replay an explicit authentication rejection; do not clear a newer in-memory token.
        if (error.code === 'access_token_expired' && error.status === 401 && attempt === 0) {
          if (this.auth.access?.access_token === token) this.auth.access = null
          continue
        }
        if (!(error instanceof APIError)) throw error
        const failure = new APIError(error.code, error.status, error.retryAfter, identity.grantId)
        Object.defineProperty(failure, 'pipaAccessResponse', { value: true })
        if (identity.credentialGeneration) Object.defineProperty(failure, 'credentialGeneration', { value: identity.credentialGeneration })
        throw failure
      }
    }
  }

  async listTools({ signal } = {}) {
    try {
      const result = await retryOnce(() => this.authorized('/tools', { signal }), { signal })
      const tools = validateCatalog(result)
      this.tools = tools
      return structuredClone(tools)
    } catch (error) { await this.failed(error); throw error }
  }

  async definition(name, signal) {
    if (typeof name !== 'string' || !toolName.test(name) || localNames.has(name)) throw new APIError('invalid_tool_name')
    const previous = this.tools
    let tools = previous ?? await this.listTools({ signal })
    if (previous && !tools.some((tool) => tool.name === name)) tools = await this.listTools({ signal })
    const definition = tools.find((tool) => tool.name === name)
    if (!definition) throw new APIError('tool_not_available: authorize required scopes and refresh tool list')
    return definition
  }

  async callTool(name, args = {}, { signal } = {}) {
    const body = snapshotArguments(args)
    try {
      const definition = await this.definition(name, signal)
      const safe = !definition.mutation || uuid.test(body.operation_id ?? '')
      const result = await retryOnce(() => this.authorized(`/tools/${encodeURIComponent(name)}`, {
        method: 'POST', body, signal,
      }), { safe, signal })
      if (!isRecord(result)) throw new APIError('invalid_server_response')
      const notice = this.auth.status ? expiryNotice(await this.auth.status().catch(() => null)) : undefined
      return notice ? { ...result, connection_notice: notice } : result
    } catch (error) { await this.failed(error); throw error }
  }

  async status({ signal } = {}) {
    if (signal?.aborted) throw new APIError('request_cancelled')
    let failure
    try { await this.listTools({ signal }) } catch (error) { failure = error }
    if (signal?.aborted || failure?.code === 'request_cancelled') throw new APIError('request_cancelled')
    let status
    try { status = await this.auth.status() }
    catch { return { product: 'PIPA', server: this.origin, ...describeConnection('credential_unavailable') } }
    if (signal?.aborted) throw new APIError('request_cancelled')
    return { ...status, connection_notice: expiryNotice(status),
      discovery_error: ['signed_out', 'awaiting_user'].includes(status.state) ? undefined
        : failure instanceof APIError ? failure.code : failure ? 'credential_file_or_discovery_unavailable' : undefined }
  }

  async failed(error) {
    if (error && typeof error === 'object') {
      if (this.failures.has(error)) return false
      this.failures.add(error)
    }
    if (await this.auth.failed?.(error).catch(() => {}) === false) return false
    if (authorizationFailure(error) || error?.code === 'authorization_required' || error?.code === 'refresh_result_uncertain') {
      this.auth.access = null; this.tools = null
    }
    return true
  }
}
