import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const execute = promisify(execFile)
const maxBytes = 1024 * 1024
const windowsACL = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
if ($env:PIPA_PRIVATE_KIND -eq 'directory') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, $allow)
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $allow)
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if ($env:PIPA_PRIVATE_KIND -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($env:PIPA_PRIVATE_PATH, $acl)
} else {
  [System.IO.File]::SetAccessControl($env:PIPA_PRIVATE_PATH, $acl)
}
`

// No user path is interpolated into PowerShell code. Only the app's private
// directory/files are passed through environment values; credentials never are.
// Use Windows PowerShell's .NET Framework directly: parent shells may supply
// an incompatible PSModulePath, making Set-Acl's module unavailable.
export async function restrictWindowsPath(target, directory, run = execute) {
  const shell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await run(shell, ['-NoProfile', '-NonInteractive', '-Command', windowsACL], {
      env: { ...process.env, PIPA_PRIVATE_PATH: target, PIPA_PRIVATE_KIND: directory ? 'directory' : 'file' },
      timeout: 10000, maxBuffer: 65536, windowsHide: true,
    })
  } catch { throw new Error('credential_permissions_unavailable: allow owner-only file access before connecting') }
}

export class PrivateFiles {
  constructor(directory, { platform = process.platform, restrictWindows = restrictWindowsPath } = {}) {
    this.directory = directory; this.platform = platform; this.restrictWindows = restrictWindows
    this.initializing = null; this.secured = new Set()
  }
  async prepare() {
    if (!this.initializing) this.initializing = this.initialize().catch((error) => { this.initializing = null; throw error })
    return this.initializing
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_credential_directory')
    if (this.platform === 'win32') await this.restrictWindows(this.directory, true)
    else {
      assertOwner(info)
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { if ((info.mode & 0o777) !== 0o700) await directory.chmod(0o700) } finally { await directory.close() }
    }
  }
  file(name) {
    if (!['auth.json', 'config.json'].includes(name)) throw new Error('invalid_private_filename')
    return path.join(this.directory, name)
  }
  async read(name) {
    await this.prepare()
    const file = this.file(name)
    let handle
    try {
      const info = await lstat(file)
      assertRegular(info)
      if (this.platform === 'win32' && !this.secured.has(file)) {
        await this.restrictWindows(file, false); this.secured.add(file)
      }
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
      const opened = await handle.stat()
      assertRegular(opened)
      if (this.platform !== 'win32') { assertOwner(opened); if ((opened.mode & 0o777) !== 0o600) await handle.chmod(0o600) }
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > maxBytes) throw new Error('credential_file_too_large')
      return JSON.parse(text)
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, profiles: {} }
      throw new Error('credential_file_unavailable: check file permissions and JSON format; never paste its contents into chat')
    } finally { await handle?.close() }
  }
  async write(name, value) {
    await this.prepare()
    const target = this.file(name), temp = path.join(this.directory, `.${name}.${randomUUID()}.tmp`)
    let handle, created = false
    try {
      await assertReplaceable(target)
      const text = JSON.stringify(value)
      if (Buffer.byteLength(text) > maxBytes) throw new Error('credential_file_too_large')
      handle = await open(temp, 'wx', 0o600); created = true
      // Windows files inherit the protected owner-only directory ACL.
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null
      await rename(temp, target); this.secured.add(target)
    } catch { throw new Error('credential_save_failed: check private file access; revoke the connection on PIPA if needed') }
    finally {
      await handle?.close()
      if (created) await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw new Error('credential_temp_cleanup_failed') })
    }
  }
}

function assertRegular(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error('unsafe_credential_file')
}
function assertOwner(info) {
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('credential_owner_mismatch')
}
async function assertReplaceable(file) {
  try { assertRegular(await lstat(file)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
