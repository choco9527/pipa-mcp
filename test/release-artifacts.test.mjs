import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { version } from '../src/about.mjs'

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8')

test('one MIT npm package exposes both interfaces through one pipa executable', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.equal(pkg.name, '@choco9527/pipa-cli')
  assert.equal(pkg.version, version)
  assert.notEqual(pkg.private, true)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.publishConfig.access, 'public')
  assert.deepEqual(pkg.bin, { pipa: 'src/bin.mjs' })
  assert.deepEqual(pkg.files, ['src', 'skills', 'README.md', 'LICENSE', 'npm-shrinkwrap.json'])
  assert.equal(pkg.scripts.postinstall, undefined)
  assert.equal(pkg.scripts.preinstall, undefined)
  assert.match(await read('../LICENSE'), /^MIT License/)
})

test('manual client configuration is optional and installation has no client-specific parser dependencies', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.equal(pkg.dependencies['jsonc-parser'], undefined)
  assert.equal(pkg.dependencies['smol-toml'], undefined)
  const readme = await read('../README.md')
  assert.doesNotMatch(readme, /cursor\.com\/en\/install-mcp\?/)
  assert.match(readme, /--ignore-scripts/)
})
