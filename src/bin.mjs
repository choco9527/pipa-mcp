#!/usr/bin/env node

// Both interfaces share credentials and HTTP logic; neither starts the other.
const args = process.argv.slice(2)
let commandIndex = 0
while (commandIndex < args.length && args[commandIndex].startsWith('-')) {
  commandIndex += ['--server', '--profile'].includes(args[commandIndex]) ? 2 : 1
}
if (args[commandIndex] === 'mcp') {
  const { runMcp } = await import('./mcp.mjs')
  process.exitCode = await runMcp([...args.slice(0, commandIndex), ...args.slice(commandIndex + 1)])
} else {
  const { runCLI } = await import('./cli.mjs')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try { process.exitCode = await runCLI(args, { signal: controller.signal }) }
  finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
