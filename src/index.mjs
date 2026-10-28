#!/usr/bin/env node
// Compatibility entry for existing source-based MCP configurations.
import { runMcp } from './mcp.mjs'
process.exitCode = await runMcp(process.argv.slice(2))
