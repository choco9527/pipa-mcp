import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runCLI, parseCLI } from '../src/cli.mjs'

const operationId = 'c893d953-8374-4a48-831a-0de7f2915a04'
const taskId = 'f3ad4f4f-e493-45bd-84f1-9192b9450528'
const listId = '45b722bb-2e7c-4414-9d22-41b086e50fa5'

function writer() {
  const chunks = []
  return { stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    text: () => Buffer.concat(chunks).toString('utf8') }
}

function fixture() {
  const out = writer(), err = writer()
  const calls = []
  let factoryCalls = 0, closed = 0, disconnected = 0, pairings = 0
  let authStatus = { state: 'connected', code: 'connected' }
  let remoteStatus = { state: 'connected', code: 'connected', expires_at: 1900000000 }
  const tools = [
    { name: 'pipa_profile', description: 'profile', inputSchema: {}, mutation: false, destructive: false },
    { name: 'pipa_lists', description: 'lists', inputSchema: {}, mutation: false, destructive: false },
    { name: 'pipa_tasks_search', description: 'search', inputSchema: {}, mutation: false, destructive: false },
    { name: 'pipa_task_get', description: 'get', inputSchema: {}, mutation: false, destructive: false },
    { name: 'pipa_task_create', description: 'create', inputSchema: { required: ['operation_id', 'list_id', 'title'] }, mutation: true, destructive: false },
    { name: 'pipa_task_complete', description: 'complete', inputSchema: {}, mutation: true, destructive: true },
    { name: 'pipa_notes_search', description: 'notes', inputSchema: {}, mutation: false, destructive: false },
    { name: 'pipa_new_write', description: 'new tool', inputSchema: {}, mutation: true, destructive: false },
  ]
  const auth = {
    async begin() { pairings++; return { verification_uri: 'https://pipa.chooco.top/agent/authorize#code=ABCDEFG234567', user_code: 'ABCDEFG234567', expires_at: Math.floor(Date.now() / 1000) + 60 } },
    async status() { return authStatus },
    async disconnect() { disconnected++; return { disconnected: true } },
    close() { closed++ },
  }
  const client = {
    async listTools() { return tools },
    async callTool(name, input) { calls.push({ name, input }); return { saved: true } },
    async status() { return remoteStatus },
  }
  const runtimeFactory = async () => { factoryCalls++; return { auth, client } }
  const run = (args, extra = {}) => runCLI(args, { output: out.stream, errorOutput: err.stream, runtimeFactory, ...extra })
  return { out, err, run, calls, tools, auth, client, setAuthStatus: (value) => { authStatus = value },
    setRemoteStatus: (value) => { remoteStatus = value }, factoryCalls: () => factoryCalls, closed: () => closed,
    disconnected: () => disconnected, pairings: () => pairings }
}

test('help and version work offline without constructing credentials or client', async () => {
  for (const args of [['--help'], ['tasks', 'create', '--help'], ['--version']]) {
    const f = fixture()
    assert.equal(await f.run(args), 0)
    assert.equal(f.factoryCalls(), 0)
    assert.ok(f.out.text().length)
  }
  const f = fixture()
  assert.equal(await f.run(['tasks', 'create', '--help']), 0)
  assert.match(f.out.text(), /operation_id/)
  assert.match(f.out.text(), /list_id/)
  assert.match(f.out.text(), /title/)
})

test('validates syntax, input, profile and confirmation before creating credentials', async () => {
  for (const args of [
    ['logout'], ['--profile', '../bad', 'status'], ['--server', 'https://example.com/path', 'status'],
    ['tasks', 'create', '--input', '{broken'], ['tasks', 'create', '--input', '{}'],
    ['call', 'pipa_task_create', '--input', '{}'], ['tasks', 'list', '--unknown'],
    ['tasks', 'get', 'not-a-uuid'], ['call', 'not_pipa_tool'],
  ]) {
    const f = fixture()
    assert.equal(await f.run(args), 1, args.join(' '))
    assert.equal(f.factoryCalls(), 0, args.join(' '))
    assert.equal(f.closed(), 0)
  }
})

test('logout requires --yes and only then revokes shared authorization', async () => {
  const f = fixture()
  assert.equal(await f.run(['logout', '--yes', '--json']), 0)
  assert.equal(f.disconnected(), 1)
  assert.equal(f.closed(), 1)
  assert.deepEqual(JSON.parse(f.out.text()), { disconnected: true })
})

test('friendly aliases use server tool names without inventing or changing operation_id', async () => {
  const f = fixture()
  const input = { operation_id: operationId, list_id: listId, title: 'test task' }
  assert.equal(await f.run(['--json', 'tasks', 'create', '--input', JSON.stringify(input)]), 0)
  assert.deepEqual(f.calls, [{ name: 'pipa_task_create', input }])
  assert.deepEqual(JSON.parse(f.out.text()), { saved: true })
  assert.equal(f.closed(), 1)
})

test('get accepts a positional UUID and refuses ambiguous duplicated IDs', async () => {
  const f = fixture()
  assert.equal(await f.run(['tasks', 'get', taskId, '--json']), 0)
  assert.deepEqual(f.calls, [{ name: 'pipa_task_get', input: { id: taskId } }])
  const g = fixture()
  assert.equal(await g.run(['tasks', 'get', taskId, '--input', JSON.stringify({ id: taskId })]), 1)
  assert.equal(g.factoryCalls(), 0)
})

test('unknown future mutations require operation_id after the server catalog is obtained', async () => {
  const f = fixture()
  assert.equal(await f.run(['call', 'pipa_new_write', '--input', '{}', '--json']), 1)
  assert.equal(f.factoryCalls(), 1)
  assert.equal(f.calls.length, 0)
  assert.equal(JSON.parse(f.out.text()).error, 'operation_id_required')
})

test('server tool catalog and schemas remain available without duplicating their definitions', async () => {
  const f = fixture()
  assert.equal(await f.run(['tools', 'show', 'pipa_task_create', '--json']), 0)
  assert.deepEqual(JSON.parse(f.out.text()).inputSchema.required, ['operation_id', 'list_id', 'title'])
})

test('accepts bounded JSON from file and standard input without printing its contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipa-cli-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'input.json')
  const args = { operation_id: operationId, list_id: listId, title: 'from file' }
  await fs.writeFile(file, JSON.stringify(args))
  const f = fixture()
  assert.equal(await f.run(['tasks', 'create', '--input', `@${file}`]), 0)
  assert.deepEqual(f.calls[0].input, args)
  const g = fixture()
  const stdin = Readable.from([JSON.stringify({ query: 'meeting' })])
  assert.equal(await g.run(['tasks', 'list', '--input', '-'], { input: stdin }), 0)
  assert.deepEqual(g.calls[0].input, { query: 'meeting' })
})

test('rejects too-large or unsafe-number input without network access', async () => {
  for (const value of ['x'.repeat(1024 * 1024 + 1), '{"due_at":9007199254740992}']) {
    const f = fixture()
    assert.equal(await f.run(['tasks', 'list', '--input', value]), 1)
    assert.equal(f.factoryCalls(), 0)
    assert.equal(f.err.text().includes(value.slice(0, 100)), false)
  }
})

test('login prints link for the user and waits until the connection is verified', async () => {
  const f = fixture()
  f.setRemoteStatus({ state: 'signed_out', code: 'authorization_required' })
  f.setAuthStatus({ state: 'awaiting_user', code: 'authorization_pending' })
  const sleep = async () => { f.setAuthStatus({ state: 'connected', code: 'connected' }); f.setRemoteStatus({ state: 'connected' }) }
  assert.equal(await f.run(['login'], { sleep }), 0)
  assert.match(f.out.text(), /https:\/\/pipa\.chooco\.top\/agent\/authorize/)
  assert.match(f.out.text(), /ABCDEFG234567/)
  assert.match(f.out.text(), /点击“同意”/)
  assert.doesNotMatch(f.out.text(), /配对码：|核对账户/)
  assert.match(f.out.text(), /connected/)
  assert.equal(f.closed(), 1)
})

test('login --json sends the user link to stderr and one final JSON to stdout', async () => {
  const f = fixture()
  f.setRemoteStatus({ state: 'signed_out', code: 'authorization_required' })
  f.setAuthStatus({ state: 'awaiting_user', code: 'authorization_pending' })
  const sleep = async () => { f.setAuthStatus({ state: 'connected', code: 'connected' }); f.setRemoteStatus({ state: 'connected' }) }
  assert.equal(await f.run(['--json', 'login'], { sleep }), 0)
  assert.equal(JSON.parse(f.out.text()).state, 'connected')
  assert.match(f.err.text(), /ABCDEFG234567/)
})

test('failed login and disconnected status return nonzero without reporting success', async () => {
  const f = fixture()
  f.setRemoteStatus({ state: 'signed_out', code: 'authorization_required' })
  f.setAuthStatus({ state: 'signed_out', code: 'authorization_denied', message: '用户拒绝' })
  assert.equal(await f.run(['login', '--json']), 1)
  assert.equal(JSON.parse(f.out.text()).error, 'authorization_denied')
  const g = fixture()
  g.setRemoteStatus({ state: 'offline', code: 'network_error', message: '网络不可用' })
  assert.equal(await g.run(['status', '--json']), 1)
  assert.equal(JSON.parse(g.out.text()).state, 'offline')
})

test('login reuses verified shared authorization and never pairs during network or gateway trouble', async () => {
  const connected = fixture()
  assert.equal(await connected.run(['login', '--json']), 0)
  assert.equal(connected.pairings(), 0)
  assert.equal(JSON.parse(connected.out.text()).state, 'connected')
  for (const state of ['offline', 'blocked', 'error']) {
    const f = fixture()
    f.setRemoteStatus({ state, code: 'network_error', message: '请检查连接' })
    assert.equal(await f.run(['login', '--json']), 1)
    assert.equal(f.pairings(), 0)
  }
})

test('cancels a waiting stdin before constructing credentials', async () => {
  const f = fixture()
  const input = new Readable({ read() {} })
  const controller = new AbortController()
  const running = f.run(['tasks', 'list', '--input', '-', '--json'], { input, signal: controller.signal })
  controller.abort()
  assert.equal(await running, 130)
  assert.equal(JSON.parse(f.out.text()).error, 'request_cancelled')
  assert.equal(f.factoryCalls(), 0)
})

test('never prints authentication tokens from a response or exception', async () => {
  const f = fixture()
  const secret = `par1_${'a'.repeat(43)}`
  f.client.callTool = async () => ({ refresh_token: secret, note: `Bearer ${secret}`, nested: { device_code: secret } })
  assert.equal(await f.run(['profile', '--json']), 0)
  assert.equal(f.out.text().includes(secret), false)
  const g = fixture()
  g.client.listTools = async () => { throw new Error(`unsafe ${secret}`) }
  assert.equal(await g.run(['tools', 'list', '--json']), 1)
  assert.equal(g.out.text().includes(secret), false)
  assert.equal(g.err.text().includes(secret), false)
})

test('ambiguous rejection of an old access token does not ask for a second login', async () => {
  const f = fixture()
  const failure = Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' })
  Object.defineProperty(failure, 'pipaAccessResponse', { value: true })
  f.client.listTools = async () => { throw failure }
  assert.equal(await f.run(['tasks', 'list', '--json']), 1)
  assert.equal(JSON.parse(f.out.text()).next_action, 'pipa status --json')
  assert.match(JSON.parse(f.out.text()).message, /已保留共享登录/)
})
