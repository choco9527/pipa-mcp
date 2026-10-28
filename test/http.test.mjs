import test from 'node:test'
import assert from 'node:assert/strict'
import { APIError, requestJSON, retryOnce } from '../src/http.mjs'
import { Connector } from '../src/connector.mjs'

function interruptedResponse(error = new TypeError('terminated')) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"task":')) },
    pull(controller) { controller.error(error) },
  }), { headers: { 'Content-Type': 'application/json' } })
}

test('a response interrupted after headers retries once with the exact same write', async () => {
  const requests = []
  const args = { operation_id: '77777777-7777-4777-8777-777777777777', title: 'test-only' }
  const connector = new Connector({
    server: 'https://pipa.test', auth: { accessToken: async () => 'dummy', close() {} },
    request: (server, path, options) => requestJSON(server, path, { ...options, fetcher: async (_url, request) => {
      if (path === '/tools') return Response.json({ tools: [{ name: 'pipa_task_create', inputSchema: { type: 'object' }, mutation: true, destructive: false }] })
      requests.push(request.body)
      return requests.length === 1 ? interruptedResponse() : Response.json({ task: { id: 'created' } })
    } }),
  })
  await connector.discover()
  const result = await connector.call('pipa_task_create', args)
  assert.equal(result.isError, false)
  assert.equal(result.structuredContent.task.id, 'created')
  assert.deepEqual(requests, [JSON.stringify(args), JSON.stringify(args)])
  await connector.close()
})

test('repeated body disconnects stop after one safe retry', async () => {
  let calls = 0
  const run = () => requestJSON('https://pipa.test', '/me', { fetcher: async () => { calls++; return interruptedResponse() } })
  await assert.rejects(retryOnce(run, { sleep: async () => {} }), { code: 'network_error' })
  assert.equal(calls, 2)
})

test('unsafe writes do not retry a body disconnect', async () => {
  let calls = 0
  const run = () => requestJSON('https://pipa.test', '/tools/pipa_task_create', { method: 'POST', fetcher: async () => { calls++; return interruptedResponse() } })
  await assert.rejects(retryOnce(run, { safe: false, sleep: async () => {} }), { code: 'network_error' })
  assert.equal(calls, 1)
})

test('cancelling while reading the body is reported and never retried', async () => {
  const cancellation = new AbortController()
  let calls = 0
  const run = () => requestJSON('https://pipa.test', '/me', { signal: cancellation.signal, fetcher: async (_url, { signal }) => {
    calls++
    const response = new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    } }), { headers: { 'Content-Type': 'application/json' } })
    setTimeout(() => cancellation.abort(), 0)
    return response
  } })
  await assert.rejects(retryOnce(run, { signal: cancellation.signal, sleep: async () => {} }), { code: 'request_cancelled' })
  assert.equal(calls, 1)
})

test('body transport timeouts can retry without treating them as user cancellation', async () => {
  let calls = 0
  const result = await retryOnce(() => requestJSON('https://pipa.test', '/me', { fetcher: async () => {
    calls++
    return calls === 1 ? interruptedResponse(new DOMException('timed out', 'TimeoutError')) : Response.json({ ok: true })
  } }), { sleep: async () => {} })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
})

test('invalid JSON, gateway HTML and oversized responses are not network retries', async () => {
  for (const [response, code] of [
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'invalid_server_response'],
    [() => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), 'gateway_login_or_non_json: machine routes must not require browser challenges'],
    [() => Response.json({ content: 'x'.repeat(8 * 1024 * 1024) }), 'response_too_large'],
    [() => new Response(null, { headers: { 'Content-Type': 'application/json' } }), 'invalid_server_response'],
  ]) {
    let calls = 0
    const run = () => requestJSON('https://pipa.test', '/me', { fetcher: async () => { calls++; return response() } })
    await assert.rejects(retryOnce(run, { sleep: async () => {} }), (error) => error instanceof APIError && error.code === code)
    assert.equal(calls, 1, code)
  }
})
test('cancelling during retry delay returns request_cancelled without replaying', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = retryOnce(async () => { calls++; throw new APIError('network_error') }, {
    signal: controller.signal,
    sleep: async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError') },
  })
  await assert.rejects(pending, { code: 'request_cancelled' })
  assert.equal(calls, 1)
})
