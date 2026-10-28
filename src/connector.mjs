import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { introduction, version } from './about.mjs'
import { scopes } from './auth.mjs'
import { APIError, requestJSON } from './http.mjs'
import { PipaClient } from './client.mjs'
import { connectionFailure, describeConnection } from './connection-state.mjs'

const emptySchema = { type: 'object', properties: {}, additionalProperties: false }
const localTools = [
  { name: 'pipa_about', description: introduction, inputSchema: emptySchema, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pipa_connect', description: 'Return a link for the user to open and click “同意” (Agree) once. Default access is full task and note management (read, create, update, complete, delete and restore). Never opens or approves the link. Omit scopes for normal use; an explicit subset is supported for restricted connections.', inputSchema: { type: 'object', properties: { scopes: { type: 'array', items: { type: 'string', enum: scopes }, minItems: 1, maxItems: 6, uniqueItems: true } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'pipa_connection_status', description: 'Verify the PIPA connection with the server. Returns connected/expired/revoked/offline/blocked/reconnect_required, expiry and next_action. A saved local credential alone is not connected. Network failure is not expiry; reconnect only when directed.', inputSchema: emptySchema, annotations: { readOnlyHint: true } },
  { name: 'pipa_disconnect', description: 'Revoke this Agent connection and remove its local file credential. Does not log out the browser or change tasks.', inputSchema: emptySchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
]
export function toolResult(data, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } }

export class Connector {
  constructor({ server, auth, request = requestJSON }) {
    this.origin = server; this.auth = auth; this.request = request; this.tools = []; this.discoveryError = ''; this.discoveryFailure = null; this.discovery = null; this.closed = false
    this.client = new PipaClient({ server, auth, request })
    this.server = new Server({ name: 'pipa', version }, { capabilities: { tools: { listChanged: true } }, instructions: introduction })
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...localTools, ...this.tools] }))
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try { return await this.call(request.params.name, request.params.arguments ?? {}, extra.signal) }
      catch (error) { return this.errorResult(error) }
    })
    this.server.oninitialized = () => { void this.discover() }
    this.auth.onChange = () => { void this.discover() }
  }
  async connect(transport) {
    await this.server.connect(transport)
    // Initialization remains immediate, even with unavailable storage or an offline server.
    this.timer = setInterval(() => { void this.discover() }, 60000); this.timer.unref()
  }
  async discover() {
    if (this.closed) return
    if (this.discovery) return this.discovery
    this.discovery = this.loadTools().finally(() => { this.discovery = null })
    return this.discovery
  }
  async loadTools() {
    try {
      const catalog = await this.client.listTools()
      const tools = catalog.map(({ mutation, destructive, ...tool }) => ({ ...tool,
        annotations: { readOnlyHint: !mutation, destructiveHint: destructive, idempotentHint: true, openWorldHint: false } }))
      this.discoveryError = ''; this.discoveryFailure = null
      if (JSON.stringify(tools) !== JSON.stringify(this.tools)) { this.tools = tools; await this.changed() }
    } catch (error) {
      this.discoveryError = error instanceof APIError ? error.code : 'credential_file_or_discovery_unavailable'
      this.discoveryFailure = error
      await this.failed(error)
    }
  }
  async call(name, args, signal) {
    const local = localTools.find((tool) => tool.name === name)
    if (local) {
      validateLocalArgs(name, args)
      if (name === 'pipa_about') return toolResult({ product: 'PIPA', introduction, server: this.origin, capabilities: 'Tasks, calendars, recurrence and notes. Server-maintained tools/help after authorization.', discovery_error: this.discoveryError || undefined })
      if (name === 'pipa_connect') return toolResult(await this.auth.begin(args.scopes))
      if (name === 'pipa_connection_status') {
        const status = await this.client.status({ signal })
        if (this.client.tools === null && this.tools.length) { this.tools = []; await this.changed() }
        return toolResult(status)
      }
      const result = await this.auth.disconnect(signal); this.tools = []; await this.changed(); return toolResult(result)
    }
    if (!this.tools.some((tool) => tool.name === name)) {
      await this.discover()
      if (!this.tools.some((tool) => tool.name === name)) throw this.discoveryFailure ?? new APIError('tool_not_available: authorize required scopes and refresh tool list')
    }
    try {
      return toolResult(await this.client.callTool(name, args, { signal }))
    } catch (error) { await this.failed(error); throw error }
  }
  async authorized(path, options = {}) {
    return this.client.authorized(path, options)
  }
  async failed(error) {
    await this.client.failed(error)
    if (this.client.tools === null && this.tools.length) { this.tools = []; await this.changed() }
  }
  async errorResult(error) {
    await this.failed(error)
    const connection = await this.auth.status?.().catch(() => describeConnection('credential_unavailable'))
    const reason = connectionFailure(error)
    const changed = error.grantId && connection?.grant_id && error.grantId !== connection.grant_id
    const retainedAccess = error.pipaAccessResponse && ['invalid_grant', 'unauthorized', 'authorization_invalid', 'access_token_expired'].includes(error.code)
      && ['unverified', 'connected'].includes(connection?.state)
    const recovery = changed ? { message: '请求使用的旧连接已变化，未清除新连接。请检查当前连接状态后再继续。', next_action: 'pipa_connection_status' }
      : retainedAccess ? { message: '本次请求未被接受，共享登录已保留。请检查连接状态后再决定是否重试本次操作。',
        next_action: 'pipa_connection_status', reconnect_required: false, retryable: false } : reason ? describeConnection(reason) : null
    return toolResult({ error: error instanceof APIError ? error.code.split(':', 1)[0] : 'connector_error',
      message: recovery?.message ?? (error.code === 'insufficient_scope' ? '当前连接缺少此操作权限，不代表授权过期。' : '操作未确认成功，请根据错误检查参数或重新读取数据。'),
      next_action: recovery?.next_action ?? (error.code === 'insufficient_scope' ? 'review_permissions' : 'check_request'),
      retryable: recovery?.retryable ?? false, reconnect_required: recovery?.reconnect_required ?? false, connection,
      ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) }, true)
  }
  async changed() { await this.server.sendToolListChanged().catch(() => {}) }
  async close() { this.closed = true; clearInterval(this.timer); this.auth.close(); await this.server.close() }
}
function validateLocalArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => name !== 'pipa_connect' || key !== 'scopes')) throw new APIError('invalid_arguments')
}
