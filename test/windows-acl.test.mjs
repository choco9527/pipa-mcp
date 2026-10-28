import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { restrictWindowsPath } from '../src/private-files.mjs'

const execute = promisify(execFile)

test('native Windows protects credentials even when parent PowerShell modules are unavailable',
  { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pipa-acl-fixture-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let invocation
    const run = async (command, args, options) => {
      const isolated = { ...options, env: { ...options.env, PSModulePath: path.join(directory, 'no-modules') } }
      invocation = { command, options: isolated }
      try { return await execute(command, args, isolated) }
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
    const script = "$a = [System.IO.File]::GetAccessControl($env:PIPA_PRIVATE_PATH); "
      + "$s = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
      + "[Console]::WriteLine($a.AreAccessRulesProtected); "
      + "[Console]::WriteLine($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); "
      + "[Console]::WriteLine($s); "
      + "foreach ($r in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { "
      + "[Console]::WriteLine($r.IdentityReference.Value + '|' + $r.FileSystemRights + '|' + $r.AccessControlType) }"
    const result = await execute(invocation.command, ['-NoProfile', '-NonInteractive', '-Command', script], invocation.options)
    const [protectedACL, owner, current, ...rules] = result.stdout.trim().split(/\r?\n/)
    assert.equal(protectedACL, 'True')
    assert.equal(owner, current)
    assert.deepEqual(rules, [`${current}|FullControl|Allow`])
  })
