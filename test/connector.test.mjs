import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Connector } from '../src/connector.mjs'
import { APIError, requestJSON, retryOnce } from '../src/http.mjs'
import { parseOptions, platformDirectory } from '../src/options.mjs'
import { help } from '../src/about.mjs'

test('generic MCP initializes immediately without authorization and introduces PIPA', async (t) => {
  const auth = { async accessToken() { throw new APIError('authorization_required', 401) }, async status() { return { state: 'signed_out' } }, close() {} }
  const connector = new Connector({ server: 'https://pipa.test', auth })
  const client = new Client({ name: 'vendor-neutral-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  t.after(async () => { await client.close(); await connector.close() })
  await connector.connect(serverTransport); await client.connect(clientTransport)
  const tools = await client.listTools()
  assert.ok(tools.tools.some((tool) => tool.name === 'pipa_connect'))
  const about = await client.callTool({ name: 'pipa_about', arguments: {} })
  assert.match(about.content[0].text, /待办/)
  assert.match(client.getInstructions(), /personal workspace/)
  assert.ok(!tools.tools.some((tool) => tool.name === 'pipa_task_delete'))
})

test('business tool discovery updates without a package release', async () => {
  let names = ['pipa_one']
  const connector = new Connector({ server: 'https://pipa.test', auth: { accessToken: async () => 'dummy', close() {} }, request: async () => ({ tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' }, mutation: false, destructive: false })) }) })
  await connector.discover(); assert.equal(connector.tools.length, 1)
  names = ['pipa_one', 'pipa_new_server_tool']; await connector.discover()
  assert.ok(connector.tools.some((tool) => tool.name === 'pipa_new_server_tool'))
})

test('catalog without explicit mutation metadata is not treated as read-only', async () => {
  const connector = new Connector({ server: 'https://pipa.test', auth: { accessToken: async () => 'dummy', close() {} }, request: async () => ({ tools: [{ name: 'pipa_unknown', inputSchema: { type: 'object' } }] }) })
  await connector.discover()
  assert.equal(connector.tools.length, 0); assert.equal(connector.discoveryError, 'invalid_tool_catalog')
  await connector.close()
  await connector.discover(); assert.equal(connector.tools.length, 0)
})

test('retry exactly once for transient errors and never conflict/forbidden', async () => {
  let calls = 0
  const result = await retryOnce(async () => { if (++calls === 1) throw new APIError('network_error'); return 'ok' }, { sleep: async () => {} })
  assert.equal(result, 'ok'); assert.equal(calls, 2)
  for (const status of [400, 401, 403, 409]) {
    calls = 0
    await assert.rejects(retryOnce(async () => { calls++; throw new APIError('failure', status) }, { sleep: async () => {} }))
    assert.equal(calls, 1)
  }
  calls = 0
  await assert.rejects(retryOnce(async () => { calls++; throw new APIError('network_error') }, { safe: false }))
  assert.equal(calls, 1)
})

test('write retry preserves operation ID and exact arguments', async () => {
  const requests = []
  const connector = new Connector({ server: 'https://pipa.test', auth: { accessToken: async () => 'dummy', close() {} }, request: async (_origin, route, options) => {
    if (route === '/tools') return { tools: [{ name: 'pipa_task_create', inputSchema: { type: 'object' }, mutation: true, destructive: false }] }
    requests.push(JSON.stringify(options.body)); if (requests.length === 1) throw new APIError('network_error'); return { id: 'created' }
  } })
  await connector.discover()
  const args = { operation_id: '77777777-7777-4777-8777-777777777777', title: 'test' }
  const result = await connector.call('pipa_task_create', args)
  assert.equal(result.isError, false); assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]); assert.equal(args.title, 'test')
})

test('gateway redirect never forwards credentials and non-JSON is explained', async () => {
  let seen
  const fetcher = async (_url, options) => { seen = options; return new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }) }
  await assert.rejects(requestJSON('https://pipa.test', '/me', { token: 'test-only', fetcher }), /gateway_login/)
  assert.equal(seen.redirect, 'manual')
})

test('Windows and macOS use the same home-relative private file layout', () => {
  assert.equal(platformDirectory('win32', 'C:\\Users\\a'), 'C:\\Users\\a\\.pipa')
  assert.equal(platformDirectory('darwin', '/Users/test'), '/Users/test/.pipa')
  assert.throws(() => platformDirectory('linux'), /unsupported_platform/)
  assert.throws(() => parseOptions(['--server', 'http://public.example']), /invalid_server/)
  assert.throws(() => parseOptions(['--server', 'https://user:secret@example.com']), /invalid_server/)
  assert.throws(() => parseOptions(['--profile', '../oops']), /invalid_profile/)
  assert.equal(parseOptions([]).profile, 'default')
  assert.match(help, /PIPA 是管理待办/); assert.match(help, /\.pipa\/auth\.json/)
})
