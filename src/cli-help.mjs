export const quickStart = `PIPA 是你的待办、日程和笔记工具；人和 AI 都可以通过这个程序操作。

第一次使用：
  pipa login                   打开显示的链接，点击“同意”
  pipa tasks list --json        查看未完成待办
  pipa notes list --json        查看笔记

登录自动保存在当前电脑，CLI 和 MCP 共用，不必每次登录。
已知命令直接运行；不熟悉参数再用 pipa tools show <pipa_工具名> --json。
不要每次重复执行 status、tools list、tools show；程序会自动复用登录和工具定义。
网络失败会有限重试并保留登录；只有明确过期或撤销才需要 pipa login。
想检查连接用 pipa status --json；不要读取或发送 .pipa/auth.json。
需要 MCP 时配置 command: "pipa", args: ["mcp"]；只有终端能力则直接用 CLI。
`

export const mainHelp = `PIPA CLI — 管理待办、日程、循环任务和笔记

用法：pipa [--server HTTPS地址] [--profile 名称] [--json] <命令>

第一次用？运行 pipa login，打开链接点“同意”；随后 pipa tasks list --json。
登录一次，CLI/MCP 自动共用；已知命令直接调用，无需先查询整份工具目录。

  login                       登录或复用已有登录
  logout --yes                撤销共享授权（MCP 也会断开）
  status                      检查连接；网络故障不等于登录过期
  profile                     查看账户和时区
  lists                       查看任务清单
  tasks list|get|create|update|complete|delete|restore|schedule
  tasks recurrence set|remove 设置或停止循环
  tasks reminder set|remove   设置或移除提醒
  notes list|get|create|update|delete|restore
  tools list                  查看可用工具
  tools show <pipa_工具名>    查看该工具的参数和必填字段
  call <pipa_工具名>          直接调用工具
  mcp                         启动 MCP，供 AI 客户端连接；不是聊天界面
  help quickstart             首次使用指南（离线可读）

例：pipa tasks get <任务UUID> --json
写入示例：pipa tasks create --help
任务/笔记命令接受 --input '<JSON对象>'、--input @文件 或 --input -。
写入需 operation_id（新 UUID）；重试同次操作保持 ID 和参数不变，防止重复创建。
时间使用 Unix 秒，复杂参数以 tools show 的 Schema 为准。
--json 输出单份 JSON；登录提示在 stderr，最终结果在 stdout，非零退出表示未成功。
遇到问题：pipa status --json；命令用法：pipa <命令> --help。
`

const taskCreateHelp = `创建待办：\n  pipa tasks create --input '{"operation_id":"<UUID>","list_id":"<清单UUID>","title":"整理资料"}'\n\n先用 pipa lists 查 list_id。三个字段均必填；operation_id 由调用者提供，同一次重试必须复用。\n更多字段：pipa tools show pipa_task_create\n`

export function helpFor(tokens) {
  const name = tokens.join(' ')
  if (name === 'quickstart') return quickStart
  if (name === 'status') return 'pipa status --json：实时检查连接。connected 可用；offline 稍后重试，不必重新登录；expired/revoked 执行 pipa login；blocked 按提示检查服务器。状态输出不含密钥。\n'
  if (name === 'mcp') return 'MCP 客户端配置 command: "pipa", args: ["mcp"]。和 CLI 共用一次登录。在普通终端运行后等待输入是正常的，它等待 MCP 协议，不是自然语言聊天。只用命令行无需启动 MCP。\n'
  if (name === 'tasks create') return taskCreateHelp
  if (name === 'login') return 'pipa login：打开显示的链接，点击“同意”即可；程序会等待连接完成。\n'
  if (name === 'logout') return 'pipa logout --yes：撤销当前 profile 的共享 Agent 授权，也会断开使用同一授权的 MCP。\n'
  if (name === 'call') return 'pipa call <pipa_工具名> --input \'<JSON对象>\'：调用服务端工具；先用 tools show 查看 Schema，写入必须包含 operation_id。\n'
  if (name === 'tools' || name.startsWith('tools ')) return 'pipa tools list 查看工具；pipa tools show <pipa_工具名> 查看服务端 Schema（最多缓存 5 分钟）。已知命令直接调用，不必每次重复查询。\n'
  if (name === 'tasks' || name.startsWith('tasks ')) return 'pipa tasks list|get|create|update|complete|delete|restore|schedule；pipa tasks recurrence set|remove；pipa tasks reminder set|remove。参数通过 --input JSON 传入，写入必须包含 operation_id。\n'
  if (name === 'notes' || name.startsWith('notes ')) return 'pipa notes list|get|create|update|delete|restore。参数通过 --input JSON 传入，写入必须包含 operation_id。\n'
  return mainHelp
}
