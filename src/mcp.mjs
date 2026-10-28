/** MCP is an independent transport over the shared PIPA client, not a CLI subprocess. */
export async function runMcp(args) {
  const { help, version } = await import('./about.mjs')
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); return 0 }
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(`${version}\n`); return 0 }
  let connector
  try {
    const { parseOptions } = await import('./options.mjs')
    const options = parseOptions(args)
    const [{ CredentialStore }, { AuthSession }, { Connector }, { StdioServerTransport }] = await Promise.all([
      import('./credentials.mjs'), import('./auth.mjs'), import('./connector.mjs'), import('@modelcontextprotocol/sdk/server/stdio.js'),
    ])
    const store = new CredentialStore(options)
    const auth = new AuthSession({ ...options, store })
    connector = new Connector({ ...options, auth })
    await connector.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 2 * 1024 * 1024 }))
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      process.stdin.removeListener('end', close)
      process.removeListener('SIGINT', close)
      process.removeListener('SIGTERM', close)
      await connector.close()
    }
    process.stdin.once('end', close)
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    return 0
  } catch {
    await connector?.close().catch(() => {})
    process.stderr.write('PIPA MCP could not start. Use pipa mcp --help; requires Node 22+ and native Windows/macOS. No credentials were logged.\n')
    return 1
  }
}
