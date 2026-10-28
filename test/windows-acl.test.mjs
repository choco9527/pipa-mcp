import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { restrictWindowsPath } from '../src/private-files.mjs'

const execute = promisify(execFile)

test('native Windows protects a temporary directory and file with the current user ACL',
  { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pipa-acl-fixture-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let invocation
    const run = async (command, args, options) => {
      invocation = { command, options }
      try { return await execute(command, args, options) }
      catch (error) {
        // This invocation only touches empty test fixtures, never user credentials.
        t.diagnostic(`fixture ACL error: ${String(error.stderr || error.code).slice(0, 4000)}`)
        throw error
      }
    }
    await restrictWindowsPath(directory, true, run)
    const file = path.join(directory, 'fixture.json')
    await writeFile(file, '{}')
    await restrictWindowsPath(file, false, run)
    const script = "$a = Get-Acl -LiteralPath $env:PIPA_PRIVATE_PATH; "
      + "$s = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
      + "@{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; "
      + "current=$s; rules=@($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | "
      + "ForEach-Object { $_.IdentityReference.Value })} | ConvertTo-Json -Compress"
    const result = await execute(invocation.command, ['-NoProfile', '-NonInteractive', '-Command', script], invocation.options)
    const acl = JSON.parse(result.stdout)
    assert.equal(acl.protected, true)
    assert.equal(acl.owner, acl.current)
    assert.deepEqual(acl.rules, [acl.current])
  })
