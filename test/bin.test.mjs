import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { version } from '../src/about.mjs'

const execute = promisify(execFile)
const bin = fileURLToPath(new URL('../src/bin.mjs', import.meta.url))
const run = (args) => execute(process.execPath, [bin, ...args], { timeout: 5000 })

test('pipa defaults to short-lived CLI help, with an offline JSON version', async () => {
  const help = await run([])
  assert.match(help.stdout, /PIPA CLI/)
  assert.equal(help.stderr, '')
  const result = await run(['--version', '--json'])
  assert.deepEqual(JSON.parse(result.stdout), { version })
  assert.equal(result.stderr, '')
})

test('MCP mode is explicit and preserves its own help with globals before or after it', async () => {
  for (const args of [['mcp', '--help'], ['--help', 'mcp']]) {
    const result = await run(args)
    assert.match(result.stdout, /standard stdio MCP/)
    assert.equal(result.stderr, '')
  }
  const result = await run(['mcp', '--version'])
  assert.equal(result.stdout.trim(), version)
})

test('invalid CLI arguments fail before authorizing and return one JSON error', async () => {
  await assert.rejects(run(['tasks', 'create', '--input', '{"title":"incomplete"}', '--json']), (error) => {
    assert.equal(error.code, 1)
    assert.equal(JSON.parse(error.stdout).error, 'operation_id_required')
    assert.equal(error.stderr, '')
    return true
  })
})
