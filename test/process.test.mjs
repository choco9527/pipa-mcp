import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CredentialStore } from '../src/credentials.mjs'

const source = (name) => JSON.stringify(new URL(`../src/${name}.mjs`, import.meta.url).href)

function bounded(promise, milliseconds, description) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function monitor(child, index) {
  let stderr = '', stdout = '', finishReady, finishExit
  const ready = new Promise((resolve) => { finishReady = resolve })
  const exited = new Promise((resolve) => { finishExit = resolve })
  const diagnostic = (message) => `child ${index}: ${message}; stderr: ${stderr.slice(-4096) || '(empty)'}`
  child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-4096) })
  child.stdin.on('error', (error) => { stderr = `${stderr}\nstdin: ${error.message}`.slice(-4096) })
  child.stdout.on('data', (data) => {
    stdout += data.toString()
    if (stdout.includes('ready\n')) finishReady({ ok: true })
    stdout = stdout.slice(-4096)
  })
  child.on('error', (error) => {
    const message = diagnostic(`failed to start: ${error.message}`)
    finishReady({ ok: false, message }); finishExit({ ok: false, message })
  })
  child.on('close', (code, signal) => {
    const message = diagnostic(`exited with code ${code}, signal ${signal ?? 'none'}`)
    finishReady({ ok: false, message }); finishExit({ ok: code === 0, message })
  })
  return { child, ready, exited }
}

async function stopChildren(children) {
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill()
  await Promise.all(children.map(async ({ child, exited }) => {
    try { await bounded(exited, 5000, 'child cleanup') }
    catch { child.kill('SIGKILL') }
    finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() }
  }))
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-process-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('child monitoring reports startup failures and exits before readiness', { timeout: 15000 }, async (t) => {
  const children = []
  t.after(() => stopChildren(children))
  const missing = path.join(tmpdir(), `pipa-missing-${process.pid}-${Date.now()}`, 'executable')
  children.push(monitor(spawn(missing, [], { stdio: ['pipe', 'pipe', 'pipe'] }), 0))
  children.push(monitor(spawn(process.execPath, ['-e', "process.stderr.write('fixture failed'); process.exit(3)"],
    { stdio: ['pipe', 'pipe', 'pipe'] }), 1))
  const results = await Promise.all(children.map(({ ready }, index) => bounded(ready, 5000, `fixture ${index}`)))
  assert.equal(results[0].ok, false)
  assert.match(results[0].message, /failed to start/)
  assert.equal(results[1].ok, false)
  assert.match(results[1].message, /code 3.*fixture failed/)
})

test('independent Node processes serialize refresh and reread the previous rotation', { timeout: 120000 }, async (t) => {
  const children = []
  t.after(() => stopChildren(children))
  const directory = await temporary(t)
  const store = new CredentialStore({ directory, server: 'https://pipa.test', profile: 'test' })
  const base = { account_id: '11111111-1111-4111-8111-111111111111', grant_id: '22222222-2222-4222-8222-222222222222', scopes: ['tasks:read'], expires_at: Math.floor(Date.now() / 1000) + 86400 }
  await store.withLock(() => store.save({ ...base, refresh_token: `par1_${'a'.repeat(43)}` }))
  const script = `
    import { CredentialStore } from ${source('credentials')};
    import { AuthSession } from ${source('auth')};
    import { once } from 'node:events';
    const store = new CredentialStore({ directory: process.argv[1], server: 'https://pipa.test', profile: 'test' });
    const auth = new AuthSession({ server: store.server, store, request: async (_origin, _route, { body }) => {
      const next = String.fromCharCode(body.refresh_token.charCodeAt(5) + 1).repeat(43);
      await new Promise(resolve => setTimeout(resolve, 150));
      return { ...${JSON.stringify(base)}, token_type: 'Bearer', access_token: 'paa1_' + next, refresh_token: 'par1_' + next, access_expires_at: Math.floor(Date.now() / 1000) + 900 };
    } });
    process.stdout.write('ready\\n'); await once(process.stdin, 'data');
    await auth.accessToken(); process.stdout.write('done\\n'); process.stdin.destroy();
  `
  for (const index of [0, 1]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(monitor(child, index))
  }
  await Promise.all(children.map(async ({ ready }, index) => {
    const result = await bounded(ready, 20000, `child ${index} to become ready`)
    assert.ok(result.ok, result.message)
  }))
  for (const { child } of children) child.stdin.write('go\n')
  await Promise.all(children.map(async ({ exited }, index) => {
    const result = await bounded(exited, 60000, `child ${index} to exit`)
    assert.ok(result.ok, result.message)
  }))
  assert.equal((await store.credential(await store.metadata())).refresh_token, `par1_${'c'.repeat(43)}`)
})

test('real stdio MCP introduces PIPA without touching the user home or requiring a browser', { timeout: 60000 }, async (t) => {
  const directory = await temporary(t)
  const script = `
    import { Connector } from ${source('connector')};
    import { AuthSession } from ${source('auth')};
    import { CredentialStore } from ${source('credentials')};
    import { StdioServerTransport } from ${JSON.stringify(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', import.meta.url).href)};
    const server = 'https://pipa.test';
    const connector = new Connector({ server, auth: new AuthSession({ server, store: new CredentialStore({ server, profile: 'test', directory: process.argv[1] }) }) });
    await connector.connect(new StdioServerTransport());
    process.stdin.on('end', async () => { await connector.close() });
  `
  const client = new Client({ name: 'generic-stdio-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', script, directory], stderr: 'pipe' })
  t.after(async () => { await client.close(); await transport.close() })
  await client.connect(transport)
  const result = await client.callTool({ name: 'pipa_about', arguments: {} })
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /PIPA/)
  assert.match(client.getInstructions(), /\.pipa\/auth\.json/)
})
