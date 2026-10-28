import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const execute = promisify(execFile)
const bin = process.env.PIPA_TEST_BIN ?? fileURLToPath(new URL('../src/bin.mjs', import.meta.url))
const userCode = 'ABCDEFG234567'
const base = { account_id: '11111111-1111-4111-8111-111111111111', grant_id: '22222222-2222-4222-8222-222222222222',
  scopes: ['tasks:read'], expires_at: Math.floor(Date.now() / 1000) + 86400 }
const catalog = [{ name: 'pipa_tasks_search', description: 'Test task search', inputSchema: { type: 'object' }, mutation: false, destructive: false }]

function tokenResponse(state) {
  const suffix = String.fromCharCode(97 + state.issuances++).repeat(43)
  const result = { ...base, token_type: 'Bearer', access_token: `paa1_${suffix}`, refresh_token: `par1_${suffix}`,
    access_expires_at: Math.floor(Date.now() / 1000) + 900 }
  state.refresh = result.refresh_token
  state.access.add(result.access_token)
  return result
}

async function respond(request, response, state) {
  const chunks = []
  for await (const part of request) chunks.push(part)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
  const route = request.url.replace('/api/agent/v1', '')
  if (route === '/device') {
    state.devices++
    return send({ device_code: `pad1_${'d'.repeat(43)}`, user_code: userCode, interval: 5,
      expires_at: Math.floor(Date.now() / 1000) + 600, verification_uri_complete: `${state.origin}/agent/authorize#code=${userCode}` })
  }
  if (route === '/token') {
    if (body.grant_type === 'refresh_token' && (state.revoked || body.refresh_token !== state.refresh)) {
      return send({ error: { code: 'invalid_grant' } }, 401)
    }
    return send(tokenResponse(state))
  }
  const bearer = request.headers.authorization?.replace(/^Bearer /, '')
  if (state.revoked || !state.access.has(bearer)) return send({ error: { code: 'authorization_revoked' } }, 401)
  if (route === '/tools') return send({ tools: catalog })
  if (route === '/tools/pipa_tasks_search') return send({ tasks: [{ title: 'Isolated fixture task' }] })
  if (route === '/logout') { state.revoked = true; return send({ revoked: true }) }
  return send({ error: { code: 'not_found' } }, 404)
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-entrypoints-'))
  const state = { devices: 0, issuances: 0, access: new Set(), revoked: false, origin: '' }
  const server = createServer((request, response) => { void respond(request, response, state).catch(() => { response.writeHead(500); response.end() }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  // Mock homedir inside test child processes only; never change the real HOME or read real credentials.
  const preload = path.join(directory, 'test-home.mjs')
  await writeFile(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';\nos.homedir = () => ${JSON.stringify(directory)}; syncBuiltinESMExports();\n`)
  const common = ['--import', pathToFileURL(preload).href, bin, '--server', state.origin, '--profile', 'shared']
  return { state, common, directory, cli: (args) => execute(process.execPath, [...common, ...args], { timeout: 30000, cwd: directory }) }
}

async function mcpClient(t, fixture) {
  const client = new Client({ name: 'independent-client-fixture', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [...fixture.common, 'mcp'], cwd: fixture.directory, stderr: 'pipe' })
  t.after(async () => { await client.close(); await transport.close() })
  await client.connect(transport)
  return client
}

test('real CLI login is immediately usable by independent MCP, repeated login reuses it, logout disconnects both', { timeout: 60000 }, async (t) => {
  const fixtureData = await fixture(t)
  const loggedIn = await fixtureData.cli(['login', '--json'])
  assert.equal(JSON.parse(loggedIn.stdout).state, 'connected')
  assert.match(loggedIn.stderr, /配对码/)
  const mcp = await mcpClient(t, fixtureData)
  assert.equal((await mcp.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent.state, 'connected')
  const tasks = await mcp.callTool({ name: 'pipa_tasks_search', arguments: {} })
  assert.equal(tasks.structuredContent.tasks[0].title, 'Isolated fixture task')
  assert.equal(JSON.parse((await fixtureData.cli(['login', '--json'])).stdout).state, 'connected')
  assert.equal(fixtureData.state.devices, 1)
  const output = await fixtureData.cli(['tasks', 'list', '--json'])
  assert.equal(JSON.parse(output.stdout).tasks.length, 1)
  assert.doesNotMatch(loggedIn.stdout + loggedIn.stderr + output.stdout + JSON.stringify(tasks), /\b(?:paa1|par1|pad1)_[\w-]{43}\b/)
  assert.equal(JSON.parse((await fixtureData.cli(['logout', '--yes', '--json'])).stdout).disconnected, true)
  assert.equal((await mcp.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent.state, 'signed_out')
})

test('real MCP login is immediately usable by a standalone CLI process without a second pairing', { timeout: 60000 }, async (t) => {
  const fixtureData = await fixture(t)
  const mcp = await mcpClient(t, fixtureData)
  const pairing = await mcp.callTool({ name: 'pipa_connect', arguments: {} })
  assert.equal(pairing.structuredContent.state, 'awaiting_user')
  let status
  for (let attempt = 0; attempt < 40; attempt++) {
    status = (await mcp.callTool({ name: 'pipa_connection_status', arguments: {} })).structuredContent
    if (status.state === 'connected') break
    await delay(200)
  }
  assert.equal(status.state, 'connected')
  assert.equal(JSON.parse((await fixtureData.cli(['status', '--json'])).stdout).state, 'connected')
  assert.equal(fixtureData.state.devices, 1)
})
