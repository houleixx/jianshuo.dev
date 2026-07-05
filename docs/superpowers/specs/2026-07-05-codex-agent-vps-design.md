# codex.jianshuo.dev —— Codex 订阅版远程 agent 网页聊天（设计文档）

日期：2026-07-05
状态：设计已获批准，待实施

## 目标

用 Tokyo VPS 上已有的 Codex 订阅凭证（`/opt/paint/.codex`，paint 服务在用的那份），
开一个浏览器就能远程使用的 agent 聊天页——形态与 lab.jianshuo.dev（Claude Agent SDK 版）
完全同构，跑的是 OpenAI Codex CLI 的 agent loop。

## 已定决策（brainstorm 结论）

- **形态**：网页聊天（不是 SSH、不是官方 Codex Cloud）
- **用途**：写代码 + 管 VPS
- **权限**（2026-07-05 修订，用户选定 B 档）：CLI 层 `--sandbox danger-full-access`；
  防线移到 OS 层——进程跑非特权用户 `codex-agent`，另配 **sudoers 白名单**
  （仅 `systemctl restart/status/reload` 指定服务、`journalctl`、`caddy reload`），
  systemd 沙箱保留 `ProtectSystem=strict`（可写路径只有自身目录、共享凭证目录、`/etc/caddy`），
  但去掉 `NoNewPrivileges`/`RestrictSUIDSGID`（否则 sudo 不可用）。
  爆炸半径 = 白名单命令 + 上述可写目录。
- **实现路线**：`codex exec --json` + `codex exec resume <id>` 包装（每条消息 spawn 一次，
  无常驻 codex 进程），不用实验性的 `codex proto`，不用第三方 Web UI

## 架构

```
浏览器 ── https://codex.jianshuo.dev
  → Cloudflare 灰云 A 记录 → 66.42.45.128
  → Caddy：自动 Let's Encrypt HTTPS + basic_auth（用户 wjs，独立新密码，存 iCloud「账户和密码」）
  → 127.0.0.1:8789  node 服务（systemd codex-agent.service，非特权用户 codex-agent）
  → 每条消息 spawn：codex exec --json --sandbox danger-full-access -C /opt/codex-agent/workspace
```

与 lab.jianshuo.dev 的对应关系：同一台 VPS、同一套「Caddy 网关 + 本地端口 + systemd
非特权用户 + .env」模式；lab 用 8787，paint 用 8788，本服务用 **8789**。

## 凭证共享（关键约束）

Codex 订阅的 refresh token 是**单点轮换**的：任何一份拷贝在别处刷新后，其余拷贝立即作废
（2026-07-05 已实测：本机 `~/.codex/auth.json` 即被 VPS 的刷新踢掉，报 `refresh_token_reused`）。

因此：**绝不拷贝 auth.json**。建系统组 `codexauth`，把 `/opt/paint/.codex` 目录设为
该组可读写（setgid 保持组继承），`paint` 和 `codex-agent` 两个用户都入组，
两个服务的 `CODEX_HOME` 都指向这同一个目录——谁触发 401 刷新，新 token 都写回同一份文件。

订阅 ToS 为单用户：访问密码只归本人，不分享。

## 组件

1. **`src/server.ts`**（node，零依赖或与 lab 同栈）：
   - `POST /api/chat`：body `{chat_id?, message}`。无 `chat_id` → 新会话；有 → 查映射拿
     codex session id 走 `resume`。响应为 SSE 流。
   - 会话映射 `chat_id → codex_session_id`：内存 Map + 落盘 JSON（`/opt/codex-agent/sessions.json`），
     服务重启不丢会话。
   - spawn `codex exec --json ...`，逐行读 stdout 的 JSONL 事件，翻译成 SSE 推给前端；
     首轮从事件里截获 session id 存映射。
   - **并发闸**：同时最多 1 个 codex 进程（1GB 小机），第二条消息进来给「排队中」事件。
   - 客户端断开：监听 `res` 的 close（lab 踩过的坑），kill 子进程。
2. **`public/index.html`**：单文件浅色 UI，抄 lab 改壳——标题 Codex，事件分块渲染：
   agent 文本、命令执行（命令 + 退出码 + 输出摘要）、文件修改（路径列表）、错误红条。
   顶部「新会话」按钮。
3. **`deploy/provision.sh`**：装 Node20（已有）+ `npm i -g @openai/codex`、建
   `codex-agent` 用户与 `codexauth` 组、`/opt/codex-agent/{workspace,}` 目录、
   `/opt/paint/.codex` 改组权限、systemd unit、Caddyfile 加 codex.jianshuo.dev 段、
   提示去 Cloudflare 加灰云 A 记录。
4. **`deploy.sh`**：tsc build → rsync dist/public/deploy → 重启服务（照 lab）。
5. **systemd unit**：`User=codex-agent`，`Restart=always`，enabled；
   `ReadWritePaths=/opt/codex-agent /opt/paint/.codex`（refresh 写回要可写），其余只读加固。

## Codex CLI 配置

- 调用参数：`codex exec --json --sandbox danger-full-access -C /opt/codex-agent/workspace`
  （联网天然可用；OS 层防线见「已定决策」的 sudoers/systemd 白名单）
- 模型：用订阅默认（不锁定；要换时 `-c model=...` 加进 .env 可调项）
- `CODEX_HOME=/opt/paint/.codex`（共享凭证，见上）
- CLI 版本以 VPS 实际 `codex --version` 为准（本机验证为 0.142.3，`exec`/`resume`/`--json` 均在）

## 错误处理

- codex 非零退出 → SSE `error` 事件，网页红条摊 stderr 摘要
- 401 / `refresh_token_reused`（凭证又被外部拷贝踢掉）→ 红条提示「需在 VPS 重新 codex login」
- resume 的 session id 失效（codex 清理了 rollout）→ 自动降级为新会话并在 UI 标注
- 排队超时（>60s 没轮到）→ 提示稍后再试

## 测试

- 单测：会话映射的存取/落盘、JSONL 事件→SSE 翻译（拿录制的 codex --json 输出做 fixture）、
  并发闸（第二个请求排队）
- 手测清单：新会话问答、续聊上下文保持、跑命令写文件（限定在 workspace 内验证）、
  sudo 白名单内的命令可执行（systemctl status）、白名单外被拒（如 useradd）、
  断开取消、密码错 401、手机 Safari 可用

## 明确不做

- 多用户 / 分享（订阅 ToS 单用户）
- `codex proto` 常驻协议模式、审批交互（approval 一律走沙箱策略，不弹窗）
- 会话列表 / 历史浏览（只有当前会话 + 新会话按钮，YAGNI）
- 碰 paint 服务的任何代码（只共享 CODEX_HOME 目录权限）
