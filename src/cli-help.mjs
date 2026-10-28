export const mainHelp = `PIPA CLI — 管理待办、循环任务和笔记\n\n用法：pipa [--server HTTPS地址] [--profile 名称] [--json] <命令>\n\n  login                       显示授权链接，等待本人在网页确认\n  logout --yes                撤销此 profile 的共享授权（MCP 也会断开）\n  status                      检查本地及服务器连接状态\n  profile                     查看账户和时区\n  lists                       查看任务清单\n  tasks list|get|create|update|complete|delete|restore|schedule\n  tasks recurrence set|remove 设置或停止循环\n  tasks reminder set|remove   设置或移除提醒\n  notes list|get|create|update|delete|restore\n  tools list                  查看当前账户可用工具\n  tools show <pipa_工具名>    查看服务器提供的参数 Schema\n  call <pipa_工具名>          直接调用服务器工具\n  mcp                         启动 stdio MCP（由客户端使用）\n\n任务/笔记命令及 call 接受 --input '<JSON对象>'、--input @文件 或 --input -（标准输入）。\n所有写入都需要显式的 operation_id（UUID）；重试同一次操作须保持该 ID 和参数不变。\n绝对时间统一使用 Unix 秒，复杂参数以服务器 tools show 的 Schema 为准。\n使用 --json 输出单份 JSON；登录时授权链接显示在标准错误，最终结果写入标准输出。\n执行 pipa <命令> --help 查看示例。\n`

const taskCreateHelp = `创建待办：\n  pipa tasks create --input '{"operation_id":"<UUID>","list_id":"<清单UUID>","title":"整理资料"}'\n\n先用 pipa lists 查 list_id。三个字段均必填；operation_id 由调用者提供，同一次重试必须复用。\n更多字段：pipa tools show pipa_task_create\n`

export function helpFor(tokens) {
  const name = tokens.join(' ')
  if (name === 'tasks create') return taskCreateHelp
  if (name === 'login') return 'pipa login：显示授权链接和配对码并等待；请用户亲自打开网页、核对信息并确认。\n'
  if (name === 'logout') return 'pipa logout --yes：撤销当前 profile 的共享 Agent 授权，也会断开使用同一授权的 MCP。\n'
  if (name === 'call') return 'pipa call <pipa_工具名> --input \'<JSON对象>\'：调用服务端工具；先用 tools show 查看 Schema，写入必须包含 operation_id。\n'
  if (name === 'tools' || name.startsWith('tools ')) return 'pipa tools list 查看工具；pipa tools show <pipa_工具名> 查看服务端实时 Schema。\n'
  if (name === 'tasks' || name.startsWith('tasks ')) return 'pipa tasks list|get|create|update|complete|delete|restore|schedule；pipa tasks recurrence set|remove；pipa tasks reminder set|remove。参数通过 --input JSON 传入，写入必须包含 operation_id。\n'
  if (name === 'notes' || name.startsWith('notes ')) return 'pipa notes list|get|create|update|delete|restore。参数通过 --input JSON 传入，写入必须包含 operation_id。\n'
  return mainHelp
}
