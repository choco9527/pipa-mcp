import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CredentialStore } from '../src/credentials.mjs'
import { PrivateFiles, restrictWindowsPath } from '../src/private-files.mjs'

const account = '11111111-1111-4111-8111-111111111111', grant = '22222222-2222-4222-8222-222222222222'
function tokens(letter = 'a') { return { account_id: account, grant_id: grant, refresh_token: `par1_${letter.repeat(43)}`, scopes: ['tasks:read'], expires_at: Math.floor(Date.now() / 1000) + 86400 } }
async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), 'pipa-file-test-'))
  t.after(() => rm(value, { recursive: true, force: true }))
  return value
}
function store(dir, profile = 'one', server = 'https://pipa.test') { return new CredentialStore({ directory: dir, server, profile }) }

test('profiles and servers share a lock but keep independent credentials and revocations', async (t) => {
  const dir = await directory(t), first = store(dir), second = store(dir, 'two'), other = store(dir, 'one', 'https://other.test')
  await Promise.all([first, second, other].map((value, i) => value.withLock(() => value.save(tokens(String.fromCharCode(97 + i))))))
  assert.equal(Object.keys(JSON.parse(await readFile(first.file, 'utf8')).profiles).length, 3)
  await first.withLock(async () => first.forget(await first.metadata()))
  assert.equal(await first.metadata(), null)
  assert.equal((await second.credential(await second.metadata())).refresh_token, tokens('b').refresh_token)
  assert.equal((await other.credential(await other.metadata())).refresh_token, tokens('c').refresh_token)
})

test('metadata omits credentials and stale logout cannot remove a replacement grant', async (t) => {
  const value = store(await directory(t))
  const old = await value.withLock(() => value.save(tokens()))
  const next = { ...tokens('b'), grant_id: '33333333-3333-4333-8333-333333333333' }
  await value.withLock(() => value.save(next))
  await value.withLock(() => value.forget(old))
  assert.equal((await value.metadata()).grant_id, next.grant_id)
  assert.equal(await value.credential(old), null)
})

test('macOS/POSIX directory and credential files are private, including existing permissive files', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await directory(t), value = store(dir)
  await chmod(dir, 0o755); await value.withLock(() => value.save(tokens()))
  assert.equal((await lstat(dir)).mode & 0o777, 0o700)
  for (const file of [value.file, value.configFile]) assert.equal((await lstat(file)).mode & 0o777, 0o600)
  await chmod(value.file, 0o644); await value.metadata()
  assert.equal((await lstat(value.file)).mode & 0o777, 0o600)
})

test('malformed credentials fail without exposing their raw content', async (t) => {
  const dir = await directory(t), value = store(dir), marker = 'PRIVATE-DUMMY-DO-NOT-ECHO'
  await writeFile(value.file, `{"secret":"${marker}"`, { mode: 0o600 })
  await assert.rejects(value.metadata(), (error) => /credential_file_unavailable/.test(error.message) && !error.message.includes(marker))
  await writeFile(value.file, JSON.stringify({ version: 1, profiles: { [value.key]: { ...tokens(), expires_at: Date.now() } } }))
  await assert.rejects(value.metadata(), /invalid_credential_file/)
})

test('atomic replacement cleans temporary files and readers never see partial JSON', async (t) => {
  const value = store(await directory(t)); await value.withLock(() => value.save(tokens()))
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => value.withLock(() => value.save(tokens(i % 2 ? 'a' : 'b')))),
    ...Array.from({ length: 20 }, () => value.metadata()),
  ])
  assert.ok((await value.metadata()).grant_id)
  assert.deepEqual((await readdir(value.directory)).sort(), ['auth.json', 'config.json'])
})

test('symlink credential targets and directories are rejected without touching their targets', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await directory(t), outside = path.join(dir, 'outside.json'), privateDir = path.join(dir, 'private')
  await writeFile(outside, '{"untouched":true}')
  const value = store(privateDir); await value.prepare()
  await symlink(outside, value.file)
  await assert.rejects(value.metadata(), /credential_file_unavailable/)
  await assert.rejects(value.withLock(() => value.save(tokens())), /credential_file_unavailable/)
  assert.equal(await readFile(outside, 'utf8'), '{"untouched":true}')
  const linked = path.join(dir, 'linked'); await symlink(privateDir, linked)
  await assert.rejects(store(linked).prepare(), /unsafe_credential_directory/)
})

test('Windows ACL command uses only owner SID and literal environment path, never injected script text', async () => {
  let captured
  const target = "C:\\Users\\a\\.pipa\\auth'; Write-Host 'unexpected.json"
  await restrictWindowsPath(target, false, async (...args) => { captured = args })
  const [command, args, options] = captured
  assert.match(command, /powershell\.exe$/i)
  assert.equal(options.env.PIPA_PRIVATE_PATH, target)
  assert.equal(options.env.PIPA_PRIVATE_KIND, 'file')
  assert.ok(!args.join(' ').includes(target))
  assert.match(args.at(-1), /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(args.at(-1), /\[System\.IO\.Directory\]::SetAccessControl\(\$env:PIPA_PRIVATE_PATH, \$acl\)/)
  assert.match(args.at(-1), /\[System\.IO\.File\]::SetAccessControl\(\$env:PIPA_PRIVATE_PATH, \$acl\)/)
  assert.doesNotMatch(args.at(-1), /Set-Acl|New-Object|Import-Module/)
  await assert.rejects(restrictWindowsPath(target, true, async () => { throw new Error('blocked') }), /credential_permissions_unavailable/)
})

test('Windows owner-only ACL is applied before reading credentials', async (t) => {
  const dir = await directory(t), applied = []
  const files = new PrivateFiles(dir, { platform: 'win32', restrictWindows: async (target, isDirectory) => applied.push({ target, isDirectory }) })
  await writeFile(path.join(dir, 'auth.json'), JSON.stringify({ version: 1, profiles: {} }))
  await files.read('auth.json'); await files.read('auth.json')
  assert.deepEqual(applied, [{ target: dir, isDirectory: true }, { target: path.join(dir, 'auth.json'), isDirectory: false }])
})
