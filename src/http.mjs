import { setTimeout as delay } from 'node:timers/promises'

export class APIError extends Error {
  constructor(code, status = 0, retryAfter = 0, grantId) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; this.grantId = grantId }
}
export async function requestJSON(server, path, { method = 'GET', body, token, signal, fetcher = fetch } = {}) {
  let response, text
  try {
    response = await fetcher(`${server}/api/agent/v1${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
    })
    if (response.status >= 300 && response.status < 400 || !response.headers.get('content-type')?.includes('application/json')) throw new APIError('gateway_login_or_non_json: machine routes must not require browser challenges', response.status)
    // Fetch resolves at headers; body transmission can still fail after a committed write.
    text = await limitedText(response)
  } catch (error) {
    if (error instanceof APIError) throw error
    throw new APIError(signal?.aborted ? 'request_cancelled' : 'network_error')
  }
  let data
  try { data = JSON.parse(text) } catch { throw new APIError('invalid_server_response', response.status) }
  if (!response.ok) throw new APIError(typeof data?.error?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(data.error.code) ? data.error.code : 'request_failed', response.status, retryDelay(response.headers.get('retry-after')))
  return data
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
