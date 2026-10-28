import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CredentialStore } from '../src/credentials.mjs'

const source = (name) => JSON.stringify(new URL(`../src/${name}.mjs`, import.meta.url).href)
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipa-process-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('independent Node processes serialize refresh and reread the previous rotation', async (t) => {
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
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['pipe', 'pipe', 'pipe'] }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  const exits = children.map((child) => once(child, 'exit'))
  await Promise.all(children.map((child) => once(child.stdout, 'data')))
  for (const child of children) child.stdin.write('go\n')
  for (const exit of exits) assert.equal((await exit)[0], 0)
  assert.equal((await store.credential(await store.metadata())).refresh_token, `par1_${'c'.repeat(43)}`)
})

test('real stdio MCP introduces PIPA without touching the user home or requiring a browser', async (t) => {
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
