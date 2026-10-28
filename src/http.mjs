import { setTimeout as delay } from 'node:timers/promises'

export class APIError extends Error {
  constructor(code, status = 0, retryAfter = 0, grantId, diagnostics) {
    super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; this.grantId = grantId
    if (diagnostics) this.diagnostics = safeDiagnostics(diagnostics)
  }
}
export async function requestJSON(server, path, { method = 'GET', body, token, signal, fetcher = fetch, timeoutMs = 35000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 35000) throw new APIError('invalid_request_timeout')
  const started = performance.now(), deadline = AbortSignal.timeout(timeoutMs)
  let response, text
  const diagnostics = (error) => ({ duration_ms: Math.round(performance.now() - started),
    request_id: response?.headers.get('x-request-id'), cf_ray: response?.headers.get('cf-ray'),
    network_code: error?.cause?.code ?? error?.code,
    failure_stage: signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : response ? 'response_body' : 'connect' })
  try {
    response = await fetcher(`${server}/api/agent/v1${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    })
    if (response.status >= 300 && response.status < 400 || !response.headers.get('content-type')?.includes('application/json')) throw new APIError('gateway_login_or_non_json: machine routes must not require browser challenges', response.status)
    // Fetch resolves at headers; body transmission can still fail after a committed write.
    text = await limitedText(response)
  } catch (error) {
    if (error instanceof APIError) throw new APIError(error.code, error.status, error.retryAfter, error.grantId, diagnostics())
    throw new APIError(signal?.aborted ? 'request_cancelled' : 'network_error', 0, 0, undefined, diagnostics(error))
  }
  let data
  try { data = JSON.parse(text) } catch { throw new APIError('invalid_server_response', response.status, 0, undefined, diagnostics()) }
  if (!response.ok) throw new APIError(typeof data?.error?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(data.error.code) ? data.error.code : 'request_failed', response.status, retryDelay(response.headers.get('retry-after')), undefined, diagnostics())
  return data
}
function safeDiagnostics(value) {
  const allowedCodes = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED)$/
  return Object.freeze({ ...(Number.isSafeInteger(value.duration_ms) && value.duration_ms >= 0 ? { duration_ms: value.duration_ms } : {}),
    ...(/^[a-zA-Z0-9_-]{1,100}$/.test(value.request_id ?? '') ? { request_id: value.request_id } : {}),
    ...(/^[a-zA-Z0-9-]{1,64}$/.test(value.cf_ray ?? '') ? { cf_ray: value.cf_ray } : {}),
    ...(allowedCodes.test(value.network_code ?? '') ? { network_code: value.network_code } : {}),
    ...(['connect', 'response_body', 'timeout', 'cancelled'].includes(value.failure_stage) ? { failure_stage: value.failure_stage } : {}) })
}
async function limitedText(response) {
  if (!response.body) return ''
  const reader = response.body.getReader(); let length = 0; const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      length += value.byteLength; if (length > 8 * 1024 * 1024) throw new APIError('response_too_large')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export function retryDelay(value) {
  if (!value) return 0
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now()) || 0
}
export function transient(error) { return error.code === 'network_error' || [408, 429, 502, 503, 504].includes(error.status) }
export async function retryOnce(run, { safe = true, signal, sleep = delay } = {}) {
  try { return await run() } catch (error) {
    if (!safe || !transient(error) || signal?.aborted || error.retryAfter > 10000) throw error
    try { await sleep(Math.max(500, error.retryAfter || 0), undefined, { signal }) }
    catch (waitingError) {
      if (signal?.aborted) throw new APIError('request_cancelled')
      throw waitingError
    }
    return run()
  }
}
