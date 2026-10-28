# PIPA CLI + MCP

一个 npm 包，两种独立入口，一次安装、一次登录。管理 PIPA 的待办、清单、日程、循环任务和笔记。

- **CLI**：`pipa --help`，执行命令、返回结果、退出；任何能运行终端命令的 Agent 都可以调用，不需要配置 MCP。
- **MCP**：`pipa mcp`，以标准 stdio 协议提供工具；不调用 CLI 子进程，不依赖某一家 AI 客户端。
- 两者直接复用 HTTP 客户端和用户目录中的授权，同一系统用户、服务地址和 profile 不需要重复登录。

需要 Node.js 22+ 和 npm。当前支持原生 macOS/Windows；Windows 实机与各 AI 客户端的交互仍需分别验收，不以单元测试代替。Linux/WSL 暂未支持。

## 安装一次

公共 npm 发布完成后可使用（请先核对发布页，不将待发布包名当成已可用）：

```bash
npm install -g --ignore-scripts @choco9527/pipa-cli
pipa --help
```

不想全局安装，也可以通过 `npx --yes --ignore-scripts @choco9527/pipa-cli --help` 按需执行。`npx` 是下载/启动方式，不是 MCP；命令最后带 `mcp` 才是启动 MCP。

不依赖公共 npm 发布的方式，是从 [GitHub Releases](https://github.com/choco9527/pipa-mcp/releases) 安装同一份版本化 tarball：

```bash
npm install -g --ignore-scripts https://github.com/choco9527/pipa-mcp/releases/download/v0.1.0/pipa-cli-0.1.0.tgz
pipa --help
```

下载需要访问 GitHub，依赖安装需要访问 npm registry；没有 npm 账号也能安装公开包。发布资产附带 SHA-256 校验文件。安装/npx 请在可信目录和可信 Node/npm 环境中执行；项目 `.npmrc`、PATH 和用户 npm 配置会影响 npm，`--ignore-scripts` 不是安全沙箱。安装不会修改任何 AI 客户端配置，也不会读取或撤销现有 PIPA 授权。

## 登录一次

```bash
pipa login
pipa status --json
```

`login` 显示授权链接和配对码并等待。由本人打开链接、核对域名、账户和配对码、确认一次完整的待办/笔记管理权限；程序不会代开浏览器或批准。已有可用登录会复用，不创建第二份授权。网页仍受 PIPA 与 Cloudflare 的登录策略保护，公开安装包不代表自动取得网站访问权。

登录后 CLI 和 MCP 共用授权，短期 access token 自动刷新。新授权有效期 365 天，刷新不延长原到期日，可随时撤销。CF 网页登录到期不等于 Agent 授权到期。

```bash
pipa logout --yes
```

这会撤销当前服务/profile 的共享授权，**同时影响 CLI 和 MCP**；不会退出网页登录或删除待办。不想使用某个 MCP 客户端时只移除该客户端的配置，不必 logout。

## CLI：执行后退出

```bash
pipa --help
pipa tools list --json
pipa tools show pipa_task_create --json
pipa lists --json
pipa tasks list --json
pipa tasks get --input '{"id":"<任务 UUID>"}' --json
pipa notes list --json
```

`tools show` 返回服务端当前 Schema，复杂写入用 `--input` 传入完整 JSON；通用 `call` 也支持服务端以后新增的工具，不用等 CLI 更新。示例中的 UUID 需要替换为真实值：

```bash
pipa call pipa_task_create --input '{"operation_id":"<本次操作 UUID>","list_id":"<清单 UUID>","title":"交报告"}' --json
pipa tasks create --input @task.json --json
pipa call pipa_help --input '{"topic":"recurrence"}' --json
```

Windows PowerShell 可优先使用 UTF-8 JSON 文件以避免引号转义。支持 `--input -` 从标准输入读取；不要把凭据放进参数或输入文件。

常用命令有 `tasks`、`notes` 的查询和增删改，完整入口以 `--help` 为准。服务器维护业务 Schema、权限和帮助，CLI 不复制业务规则。写入需要显式 `operation_id`，不会偷偷生成新的操作 ID；结果不确定时沿用原 ID 和原参数重试，避免重复创建。修改前先读取最新 `version`；循环变更先确认本次/后续/整个系列范围。

`--json` 向 stdout 输出一个 JSON 结果；提示写入 stderr，错误以非零退出码表示。`login --json` 的授权链接在 stderr，终态才输出 JSON；终端应保持运行直到完成或取消。常规 `--help`/`--version` 离线可用，不读取用户凭据。绝对时间一律 Unix **秒**整数，日历语义另传 IANA 时区。

## MCP：使用同一程序

支持本地 stdio MCP 的客户端，只需配置启动命令；不需要第二次安装或登录。例如 WorkBuddy、Claude Code、Cursor 的配置形态为：

```json
{
  "mcpServers": {
    "pipa": { "command": "pipa", "args": ["mcp"] }
  }
}
```

Codex 使用对应的 TOML 配置：

```toml
[mcp_servers.pipa]
command = "pipa"
args = ["mcp"]
```

只添加 PIPA 项，不覆盖其他配置。桌面应用可能没有终端的 PATH；启动失败时，将 `command` 改为实际的 `pipa` 路径，或用绝对 Node 路径和已安装的 `src/bin.mjs` 路径加 `mcp` 参数。客户端可能要求信任 MCP，授权后如未自动发现工具，刷新工具列表或重启客户端。

MCP 未登录时提供介绍、连接、状态、断开四个工具；登录后自动发现服务器业务工具。可直接在 MCP 里 `pipa_connect` 登录，CLI 随后也能使用；反过来同理。直接在普通终端执行 `pipa mcp` 后等待输入是正常现象，它在等待 MCP 协议，不是自然语言聊天界面。

无需上架 WorkBuddy 市场即可自定义接入；当前没有市场上架或所有客户端实机验收的承诺。云端 AI 若不能执行本机程序，不能直接使用这种 stdio/CLI 方式。服务器另有远程 MCP，但本包的设备授权不是通用 OAuth 自动发现/DCR。

## 连接与安全

全局 `--server <HTTPS源站>` 和 `--profile <名称>` 用于明确选择服务和隔离账户，默认 `https://pipa.chooco.top` / `default`。只有同一系统用户、服务地址、profile 才共用授权；不同电脑不自动同步。HTTP 仅允许回环地址用于本地测试。

凭据保存在系统用户目录 `.pipa/auth.json`，是**明文 JSON**，不是加密文件：macOS 目录 `0700`、文件 `0600`；Windows 使用当前用户 SID 的专用 ACL，设置失败就停止。access token 仅存进程内存。跨进程文件锁协调刷新，原子写入避免半写文件；不要手动编辑、复制、共享或把 `.pipa` 放入仓库/云同步目录。

状态以 `pipa status --json` 或 MCP `pipa_connection_status` 为准：

- `connected`：最近服务端验证成功；`unverified` 只是本地有凭据。
- `expired` / `revoked` / `reconnect_required`：按原因重新登录，由本人确认。
- `offline`：网络暂不可用，不等于到期；保留凭据。
- `blocked`：机器接口受到登录挑战或配置异常，不通过复制浏览器 Cookie 绕过。

仅明确 `access_token_expired` 自动刷新并重发一次；网络写入只在有有效 `operation_id` 时重试，参数保持不变。刷新结果不确定时停止复用 refresh token，不谎称成功。MCP 的 `isError: true` 或 CLI 非零退出码都不代表业务写入成功。

可选 [PIPA Skill](skills/pipa-use/SKILL.md) 提供操作规则，不参与鉴权，也不要求特定 AI 产品。仅支持命令行的 Agent 读 `--help` 即可。

## 开发

独立仓库：`npm ci --ignore-scripts`、`npm test`、`npm run pack:check`。
PIPA 主仓库中：`pnpm --filter @choco9527/pipa-cli test`；直接执行 `node packages/pipa-mcp/src/bin.mjs --help`。

许可证：[MIT](LICENSE)。公开仓库只包含客户端、测试和说明，不包含 PIPA 服务器源码、私有仓库历史或用户凭据。
