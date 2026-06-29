# Claude Agent SDK — 持久化 Web 聊天（Tokyo VPS）

**日期**：2026-06-29
**状态**：设计已批准，待实现
**目标**：在 Tokyo VPS 上常驻一套基于 **Anthropic Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）的服务，并用一个浏览器聊天页暴露出来，体验「完整 Agent（像 Claude Code）」的手感——能调工具、多步自主干活，并在网页上实时看到每一次工具调用。

---

## 1. 关键事实（已核实，2026-06-29）

| 项 | 结论 |
|----|------|
| 包名 | `@anthropic-ai/claude-agent-sdk`（自带 Claude Code CLI 二进制，无需另装） |
| Node | 18+（用 20 LTS） |
| 入口 | `query({ prompt, options })` 返回 `AsyncIterable<SDKMessage>` |
| 流式 | `options.includePartialMessages: true` → `stream_event` 消息，含 `content_block_delta`（text_delta）/ `content_block_start`（tool_use）等原始 API 事件 |
| 沙箱 | `cwd`（工作目录）、`permissionMode: 'bypassPermissions'`（非交互）、`allowedTools`/`disallowedTools`、`model`、`systemPrompt`、`maxTurns` |
| 多轮 | 首轮从 `system/init` 消息取 `session_id`；后续 `options.resume = session_id` 接续 |
| 认证 | `CLAUDE_CODE_OAUTH_TOKEN`（订阅，`claude setup-token` 生成）；优先级低于 `ANTHROPIC_API_KEY`，二者互斥 |

文档来源：code.claude.com/docs/en/agent-sdk/{overview,typescript,streaming-output}、/authentication。

## 2. 认证与 ToS 边界（重要）

- 本服务用 **`CLAUDE_CODE_OAUTH_TOKEN`** 走王建硕个人订阅，不产生 API 账单。
- 官方 ToS：订阅 token 仅限**个人使用**，不得把 claude.ai 登录/额度提供给第三方。
- 因此本服务**锁定单用户**：仅王建硕本人凭密码访问，不分享密码、不做多用户。
- 若将来要分享或多用户 → 必须改用 `ANTHROPIC_API_KEY`（按量计费）。切换 = 改一个环境变量。

## 3. 架构

```
浏览器（聊天页, 浅色 UI）
   │  HTTPS + 登录密码
   ▼
Caddy（:443 自动 Let's Encrypt；:80→:443；basic_auth 密码网关）
   │  反代 → 127.0.0.1:8787
   ▼
Node 服务（TypeScript, @anthropic-ai/claude-agent-sdk）
   │  POST /api/chat → query() 跑 agent loop，SSE 流式回传事件
   ▼
沙箱工作目录 /opt/claude-agent/workspace（文件/bash 工具只在此操作）
```

- **常驻**：systemd 服务 `claude-agent.service`，`Restart=always`，开机自启。
- **隔离**：以非特权用户 `claude-agent` 运行；systemd 硬化：`ProtectSystem=strict`、`ReadWritePaths=/opt/claude-agent`、`NoNewPrivileges=yes`、`PrivateTmp=yes`。bash 破坏半径限制在工作目录 + 该用户。
- **域名**：`lab.jianshuo.dev` A 记录（Cloudflare 灰云/仅 DNS）→ `66.42.45.128`，Caddy 直接签 Let's Encrypt 证书。

## 4. 组件

### 4.1 后端 `server.ts`
- 极简 HTTP 服务（Node 内置 `http`，无框架），监听 `127.0.0.1:8787`。
- 路由：
  - `GET /` → 返回静态聊天页 `index.html`。
  - `POST /api/chat`（SSE）→ body `{ message, sessionId? }`。调 `query()`（`includePartialMessages`、`cwd`=workspace、`bypassPermissions`、默认全套工具、`model`、`maxTurns`、`resume`=sessionId）。把事件映射成 SSE：`text`（增量）/ `tool_use`（工具名+输入）/ `tool_result` / `session`（回传 session_id）/ `result`（用量）/ `error` / `done`。
  - `GET /health` → `ok`。
- 认证由 Caddy basic_auth 承担，后端只信任来自 Caddy 的本地连接。
- 错误：query() 抛错 → SSE `error` 事件，服务不崩。

### 4.2 前端 `index.html`（单文件，浅色）
- 聊天消息流 + 输入框（Enter 发送，Shift+Enter 换行）。
- 流式渲染助手文字；工具调用渲染为**可展开卡片**：`→ Bash: <cmd>` / `→ Read: <path>` / `→ WebSearch: …`，展开看输入与结果——核心「Agent 手感」。
- 顶部显示本轮用量/turns（来自 `result`）。
- 在 `localStorage` 存 `sessionId` 以便多轮接续；「新对话」按钮清空。
- 无外部依赖（纯 HTML/CSS/JS）。

### 4.3 部署产物
- `claude-agent.service`（systemd unit）。
- `Caddyfile`（`lab.jianshuo.dev` 反代 + basic_auth）。
- `.env`（`EnvironmentFile`，600 权限）：`CLAUDE_CODE_OAUTH_TOKEN`、`PORT=8787`、`MODEL=claude-opus-4-8`、`WORKSPACE=/opt/claude-agent/workspace`、`MAX_TURNS=30`。
- `deploy.sh`：本地 `tsc` → `rsync` 到 `/opt/claude-agent` → `npm ci --omit=dev` → 重启服务。

## 5. 会话与持久化
- 每浏览器会话 ↔ 一个 SDK `session_id`（各自独立 transcript）。
- SDK transcript 落盘（`/opt/claude-agent` 下 HOME），+ systemd 常驻 → 重启后仍可 `resume`。
- 工作目录单一且持久（像一台常开的 Claude Code 盒子，文件跨对话积累）。单用户并发低，不做 per-会话隔离（YAGNI）。

## 6. 安全
- Caddy basic_auth（bcrypt）单密码网关；HTTPS 强制。
- 非 root 运行 + systemd 沙箱限制 bash 破坏半径。
- `maxTurns` 上限防失控烧额度。
- token 存 `.env`（600），不进 git（`.gitignore`）。
- 诚实声明：`bypassPermissions` + 全套工具意味着登录者拥有该沙箱内等同 shell 的能力——这是「完整 Agent 手感」的代价，靠密码网关 + 非特权用户 + 目录限制兜底。

## 7. 代码位置与 Pages 隔离
- 代码在本仓库子目录 `claude-agent/`。
- 加入 `.assetsignore` + `.pagesignore`，使 `wrangler pages deploy .` 不上传它，不影响 jianshuo.dev 主站。
- `claude-agent/node_modules`、`claude-agent/dist`、`claude-agent/.env` 进 `.gitignore`。

## 8. 验收
1. 浏览器开 `https://lab.jianshuo.dev` → 弹密码 → 进聊天页（HTTPS 有效证书）。
2. 发「列出当前目录文件并新建一个 hello.txt」→ 实时看到 Bash/Write 工具卡片流式出现 → 文件确在 workspace 生成。
3. 追问一句 → 上下文连贯（resume 生效）。
4. `systemctl restart claude-agent` 后服务自动恢复、页面仍可用、旧会话可 resume。
5. 主站 `jianshuo.dev` 部署不受影响（claude-agent/ 被忽略）。

## 9. 非目标（YAGNI）
- 多用户 / 注册 / 账号体系。
- per-会话工作目录隔离。
- 会话列表 UI（仅「新对话」+ localStorage 续上最近一个）。
- 容器化（systemd 沙箱已足够，1GB 机器不上 Docker）。
