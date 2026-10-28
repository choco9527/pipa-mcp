import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function serverOrigin(value) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid_server_origin: use an HTTPS origin without credentials or paths')
  }
  return url.origin
}
export function parseOptions(args) {
  let server = 'https://pipa.chooco.top', profile = 'default'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) server = args[++i]
    else if (args[i] === '--profile' && args[i + 1]) profile = args[++i]
    else throw new Error('invalid_option: use --help')
  }
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) throw new Error('invalid_profile')
  return { server: serverOrigin(server), profile }
}
export function platformDirectory(platform = process.platform, home = homedir()) {
  if (platform === 'win32') return path.win32.join(home, '.pipa')
  if (platform === 'darwin') return path.posix.join(home, '.pipa')
  throw new Error('unsupported_platform: native Windows or macOS required; WSL is not validated')
}
export function profileKey(server, profile) { return createHash('sha256').update(`${server}\n${profile}`).digest('hex') }
