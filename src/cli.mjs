import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parseOptions } from './options.mjs'
import { version } from './about.mjs'
import { commandNames, knownWriteTools, resolveAlias } from './cli-commands.mjs'
import { helpFor, mainHelp } from './cli-help.mjs'

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const toolName = /^pipa_[a-z][a-z0-9_]{0,95}$/
const inputLimit = 1024 * 1024

class CliError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
function reject(code, message) { throw new CliError(code, message) }

function takeOption(args, index, name) {
  if (index + 1 >= args.length || typeof args[index + 1] !== 'string') reject('invalid_arguments', `${name} 需要一个值。`)
  return args[index + 1]
}

function scanArguments(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) reject('invalid_arguments', '命令参数无效。')
  const result = { tokens: [], json: false, help: false, version: false, yes: false, inputSpec: undefined, server: undefined, profile: undefined }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json' || arg === '--help' || arg === '-h' || arg === '--version' || arg === '--yes') {
      const key = arg === '--json' ? 'json' : arg === '--version' ? 'version' : arg === '--yes' ? 'yes' : 'help'
      if (result[key]) reject('invalid_arguments', `${arg} 不能重复。`)
      result[key] = true
    } else if (arg === '--input' || arg === '--server' || arg === '--profile') {
      const key = arg === '--input' ? 'inputSpec' : arg.slice(2)
      if (result[key] !== undefined) reject('invalid_arguments', `${arg} 不能重复。`)
      result[key] = takeOption(args, i, arg); i++
    } else if (arg.startsWith('-')) reject('invalid_arguments', '不支持该选项，请查看 pipa --help。')
    else result.tokens.push(arg)
  }
  return result
}

function validateGlobals(parsed) {
  const options = []
  if (parsed.server !== undefined) options.push('--server', parsed.server)
  if (parsed.profile !== undefined) options.push('--profile', parsed.profile)
  try { return parseOptions(options) } catch { reject('invalid_connection_options', '服务器地址或 profile 无效。') }
}

function resolveCommand(parsed) {
  const { tokens, yes, inputSpec } = parsed
  if (parsed.version) {
    if (tokens.length || parsed.help || yes || inputSpec !== undefined) reject('invalid_arguments', '--version 不能与其他命令一起使用。')
    return { kind: 'version' }
  }
  if (parsed.help || tokens[0] === 'help' || tokens.length === 0) {
    if (yes || inputSpec !== undefined) reject('invalid_arguments', '帮助命令不接受 --input 或 --yes。')
    return { kind: 'help', tokens: tokens[0] === 'help' ? tokens.slice(1) : tokens }
  }
  if (tokens.length === 1 && ['login', 'logout', 'status'].includes(tokens[0])) {
    if (inputSpec !== undefined || yes && tokens[0] !== 'logout') reject('invalid_arguments', '该命令不接受此选项。')
    if (tokens[0] === 'logout' && !yes) reject('confirmation_required', '注销会撤销共享授权；请明确使用 pipa logout --yes。')
    return { kind: tokens[0] }
  }
  if (yes) reject('invalid_arguments', '--yes 仅用于 logout。')
  if (tokens[0] === 'tools') {
    if (inputSpec !== undefined) reject('invalid_arguments', 'tools 不接受 --input。')
    if (tokens.length === 2 && tokens[1] === 'list') return { kind: 'tools_list' }
    if (tokens.length === 3 && tokens[1] === 'show' && toolName.test(tokens[2])) return { kind: 'tools_show', tool: tokens[2] }
    reject('invalid_arguments', '请使用 pipa tools list 或 pipa tools show <pipa_工具名>。')
  }
  if (tokens[0] === 'call') {
    if (tokens.length !== 2 || !toolName.test(tokens[1])) reject('invalid_arguments', '请使用 pipa call <pipa_工具名>。')
    return { kind: 'call', tool: tokens[1], mutation: knownWriteTools.has(tokens[1]) }
  }
  const alias = resolveAlias(tokens)
  if (!alias) reject('invalid_arguments', '命令不存在，请查看 pipa --help。')
  return { kind: 'call', ...alias }
}

async function readStdin(stream, signal) {
  if (signal?.aborted) reject('request_cancelled', '请求已取消。')
  const cancel = () => stream.destroy(new CliError('request_cancelled', '请求已取消。'))
  signal?.addEventListener('abort', cancel, { once: true })
  const chunks = []
  let length = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > inputLimit) reject('input_too_large', '输入超过 1 MiB 限制。')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks)
  } finally { signal?.removeEventListener('abort', cancel) }
}

async function inputBytes(spec, input, signal) {
  if (spec === '-') return readStdin(input, signal)
  if (spec.startsWith('@')) {
    if (spec.length === 1) reject('invalid_input', '--input @文件 需要文件路径。')
    let handle
    try {
      handle = await fs.open(spec.slice(1), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > inputLimit) reject('input_too_large', '输入文件不是普通文件或超过 1 MiB。')
      return await readStdin(handle.createReadStream({ autoClose: false }), signal)
    } catch (error) {
      if (error instanceof CliError) throw error
      reject('input_unavailable', '无法读取输入文件；请检查路径和权限。')
    } finally { await handle?.close() }
  }
  return Buffer.from(spec)
}

function checkNumbers(value, depth = 0) {
  if (depth > 64) reject('invalid_input', '输入 JSON 嵌套过深。')
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
    reject('invalid_input', '输入包含无法安全表示的数字。')
  }
  if (value && typeof value === 'object') for (const item of Object.values(value)) checkNumbers(item, depth + 1)
}

async function parseInput(spec, input, signal) {
  if (spec === undefined) return {}
  const bytes = await inputBytes(spec, input, signal)
  if (bytes.length > inputLimit) reject('input_too_large', '输入超过 1 MiB 限制。')
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { reject('invalid_input', '--input 必须是有效的 UTF-8 JSON 对象。') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_input', '--input 必须是 JSON 对象。')
  checkNumbers(value)
  return value
}

function requireOperationId(value) {
  if (typeof value.operation_id !== 'string' || !uuid.test(value.operation_id)) {
    reject('operation_id_required', '写入操作必须在 --input 中提供 operation_id（UUID）；重试同一次操作时保持不变。')
  }
}

export async function parseCLI(args, { input = process.stdin, signal } = {}) {
  if (signal?.aborted) reject('request_cancelled', '请求已取消。')
  const parsed = scanArguments(args)
  const connection = validateGlobals(parsed)
  const command = resolveCommand(parsed)
  const data = command.kind === 'call' ? await parseInput(parsed.inputSpec, input, signal) : undefined
  if (command.id !== undefined) {
    if (!uuid.test(command.id) || Object.prototype.hasOwnProperty.call(data, 'id')) reject('invalid_input', '任务或笔记 ID 无效或重复提供。')
  }
  const body = command.id === undefined ? data : { ...data, id: command.id }
  if (command.mutation) requireOperationId(body)
  return { ...command, ...(body ? { input: body } : {}), ...connection, json: parsed.json }
}

const sensitiveKey = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|device[_-]?code|token|authorization|cookie|password|api[_-]?key|client[_-]?secret|secret|credentials?)$/i
function sanitize(value, depth = 0) {
  if (depth > 64) reject('invalid_response', '响应嵌套过深，无法安全显示。')
  if (typeof value === 'string') return value.replace(/\b(?:paa1|par1|pad1)_[\w-]{43}\b/g, '[已隐藏凭据]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏凭据]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]')
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, sensitiveKey.test(key) ? '[已隐藏凭据]' : sanitize(item, depth + 1)]))
  return value
}

function human(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.error === 'string' && typeof value.message === 'string') {
    return `错误 [${value.error}]：${value.message}`
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.state === 'string') {
    return [`连接状态：${value.state}`, value.message, value.expires_at ? `授权到期（Unix 秒）：${value.expires_at}` : undefined,
      value.next_action && value.next_action !== 'none' ? `下一步：${value.next_action}` : undefined].filter(Boolean).join('\n')
  }
  if (Array.isArray(value) && value.every((item) => item && typeof item.name === 'string' && typeof item.description === 'string')) {
    return value.length ? value.map((item) => `${item.name} — ${item.description}`).join('\n') : '没有可用工具。'
  }
  return JSON.stringify(value, null, 2)
}
function emit(output, value, json) { output.write(`${json ? JSON.stringify(value) : human(value)}\n`) }

const errorMessages = Object.freeze({
  already_connected: '当前 profile 已有授权；请先用 pipa status 检查。不要为了重新登录擅自撤销。',
  authorization_required: '尚未连接 PIPA；请执行 pipa login。',
  authorization_expired: 'PIPA 授权已到期，请重新执行 pipa login。',
  authorization_revoked: 'PIPA 授权已撤销，请重新执行 pipa login。',
  authorization_invalid: '当前授权不可用，请执行 pipa login 重新连接。',
  refresh_result_uncertain: '刷新结果不确定，请重新登录，并在网页检查可能遗留的连接。',
  refresh_unavailable: '暂时无法刷新连接，登录已保留；请稍后重试原命令，无需重新登录。',
  credential_unavailable: '本地凭据读写失败，未删除登录；请检查文件权限或稍后重试。',
  network_error: '网络暂不可用，不代表授权已过期；请稍后重试。',
  insufficient_scope: '当前授权缺少操作权限，请检查 PIPA 连接权限。',
  invalid_grant: '凭据不可用，请重新登录；无法据此判断是否过期或撤销。',
  version_conflict: '数据版本已变化；请先重新读取后再决定如何修改。',
  idempotency_conflict: 'operation_id 已用于不同参数；请核对原操作。',
  request_cancelled: '请求已取消。',
  remote_revoke_failed: '服务器撤销未确认；请重试或在 PIPA 网页撤销，原凭据已保留。',
  profile_changed: '共享登录已被另一个进程更改，本次未撤销新连接。请运行 pipa status 核对后再操作。',
})

function errorResult(error) {
  if (error instanceof CliError) {
    const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error.code) ? error.code : 'cli_error'
    return { error: code, message: sanitize(error.message) }
  }
  const raw = typeof error?.code === 'string' ? error.code.split(':', 1)[0] : ''
  const code = /^[a-z][a-z0-9_]{0,99}$/.test(raw) ? raw : 'cli_error'
  if (error?.pipaAccessResponse === true && ['invalid_grant', 'unauthorized', 'authorization_invalid', 'access_token_expired'].includes(code)) {
    return { error: code, message: '本次访问凭据未被接受，已保留共享登录；请先运行 pipa status --json 检查，不必立即重新登录。', next_action: 'pipa status --json' }
  }
  const next = ['authorization_required', 'authorization_expired', 'authorization_revoked', 'authorization_invalid'].includes(code)
    ? 'pipa login' : ['refresh_unavailable', 'network_error'].includes(code) ? 'retry_same_command' : 'pipa status --json'
  return { error: code, message: errorMessages[code] ?? '操作未确认成功；命令用法见 pipa --help，连接问题用 pipa status --json 检查。', next_action: next,
    ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}) }
}

async function createRuntime({ server, profile }) {
  const [{ CredentialStore }, { AuthSession }, { PipaClient }] = await Promise.all([
    import('./credentials.mjs'), import('./auth.mjs'), import('./client.mjs'),
  ])
  const store = new CredentialStore({ server, profile })
  const auth = new AuthSession({ server, store })
  return { auth, client: new PipaClient({ server, auth }) }
}

async function waitForLogin(auth, client, start, { signal, sleep }) {
  for (;;) {
    if (signal?.aborted) reject('request_cancelled', '请求已取消。')
    const status = await auth.status()
    if (status.state === 'connected') return client.status({ signal })
    if (status.state !== 'awaiting_user') throw new CliError(status.code ?? 'login_failed', status.message ?? '授权未完成。')
    if (Number.isSafeInteger(start.expires_at) && Date.now() / 1000 >= start.expires_at) {
      reject('pairing_expired', '配对码已过期，请重新执行 pipa login。')
    }
    try { await sleep(500, undefined, { signal }) } catch { reject('request_cancelled', '请求已取消。') }
  }
}

function validateLoginPrompt(start) {
  let url
  try { url = new URL(start?.verification_uri) } catch { reject('invalid_authorization_response', '授权链接无效，请检查服务器配置。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password
    || url.pathname !== '/agent/authorize' || url.search || !/^[A-Z2-7]{13}$/.test(start.user_code)
    || url.hash !== `#code=${start.user_code}` || !Number.isSafeInteger(start.expires_at)) {
    reject('invalid_authorization_response', '授权链接或配对码无效，请检查服务器配置。')
  }
}

async function login(auth, client, { output, errorOutput, json, signal, sleep }) {
  const current = await client.status({ signal })
  if (current.state === 'connected') return current
  if (signal?.aborted) reject('request_cancelled', '请求已取消。')
  if (!['signed_out', 'expired', 'revoked', 'reconnect_required'].includes(current.state)) {
    throw new CliError(current.code ?? 'login_unavailable', current.message ?? '请先检查网络和连接状态，不必重复登录。')
  }
  const start = await auth.begin()
  validateLoginPrompt(start)
  const prompt = `打开链接，点击“同意”：\n${start.verification_uri}\n`
  ;(json ? errorOutput : output).write(prompt)
  const status = await waitForLogin(auth, client, start, { signal, sleep })
  if (status.state !== 'connected') throw new CliError(status.code ?? 'login_failed', status.message ?? '无法确认连接状态。')
  return status
}

async function callTool(client, command, signal) {
  const catalog = await client.listTools({ signal })
  const tool = catalog.find((item) => item.name === command.tool)
  if (!tool) reject('tool_unavailable', '当前授权没有这个工具；请用 pipa tools list 查看。')
  if (tool.mutation) requireOperationId(command.input)
  return client.callTool(command.tool, command.input, { signal })
}

async function execute(command, runtime, options) {
  const { auth, client } = runtime
  if (command.kind === 'login') return login(auth, client, { ...options, json: command.json })
  if (command.kind === 'logout') return auth.disconnect(options.signal)
  if (command.kind === 'status') return client.status({ signal: options.signal })
  if (command.kind === 'tools_list') return client.listTools({ signal: options.signal })
  if (command.kind === 'tools_show') {
    const tool = (await client.listTools({ signal: options.signal })).find((item) => item.name === command.tool)
    if (!tool) reject('tool_unavailable', '当前授权没有这个工具；请用 pipa tools list 查看。')
    return tool
  }
  return callTool(client, command, options.signal)
}

/** Run one human-oriented CLI command; never exits the process or starts an MCP transport. */
export async function runCLI(args, { input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  runtimeFactory = createRuntime, sleep = delay, signal } = {}) {
  let command, runtime
  const wantsJson = Array.isArray(args) && args.includes('--json')
  try {
    command = await parseCLI(args, { input, signal })
    if (command.kind === 'help') { emit(output, command.json ? { help: helpFor(command.tokens) } : helpFor(command.tokens), command.json); return 0 }
    if (command.kind === 'version') { emit(output, command.json ? { version } : version, command.json); return 0 }
    if (signal?.aborted) reject('request_cancelled', '请求已取消。')
    runtime = await runtimeFactory({ server: command.server, profile: command.profile })
    const result = await execute(command, runtime, { input, output, errorOutput, signal, sleep })
    if (result === undefined || result === null) reject('invalid_response', '服务未返回有效结果。')
    const exitCode = command.kind === 'status' && result.state !== 'connected' ? 1 : 0
    emit(output, sanitize(result), command.json)
    return exitCode
  } catch (error) {
    const result = errorResult(error)
    emit(wantsJson ? output : errorOutput, result, wantsJson)
    return result.error === 'request_cancelled' ? 130 : 1
  } finally { runtime?.auth?.close() }
}

export { commandNames, mainHelp }
