# codex-agent —— codex.jianshuo.dev

Tokyo VPS 上的 Codex 订阅版远程 agent 网页聊天。浏览器（含手机）打开
https://codex.jianshuo.dev，basic_auth 密码进入，聊天页背后每条消息 spawn 一次
`codex exec --json`（续聊 `resume <thread_id>`），JSONL 事件实时翻成 SSE。
用途：写代码 + 管 VPS。

- **架构**：Caddy（HTTPS + basic_auth `wjs`）→ `127.0.0.1:8789` node 零依赖服务
  （systemd `codex-agent.service`，非特权用户）→ codex CLI。与 lab.jianshuo.dev（8787）、
  paint（8788）同机同模式。
- **权限（B 档）**：CLI `--sandbox danger-full-access`；防线在 OS 层——
  sudoers 白名单（`/etc/sudoers.d/codex-agent`：systemctl restart/status 指定服务、
  journalctl、caddy reload）+ systemd `ProtectSystem=strict`（可写仅 `/opt/codex-agent`
  和 `/etc/caddy`）。注意 unit 里**不能**出现任何隐含 NoNewPrivileges 的选项
  （ProtectKernelTunables 等），否则 sudo 全灭。
- **凭证**：`CODEX_HOME=/opt/codex-agent/.codex`，**独立** `codex login` 会话。
  绝不拷贝别处的 auth.json（refresh token 单点轮换互踢）；也不能与 paint 共享
  （gpt-image-2-skill 的 `last_refresh` 是 epoch，codex CLI 只认 RFC3339，schema 冲突）。
  重新登录：`ssh -t -L 1455:localhost:1455 root@66.42.45.128 "sudo -u codex-agent CODEX_HOME=/opt/codex-agent/.codex HOME=/opt/codex-agent codex login"`，本机浏览器完成 OAuth。
- **CLI 坑**（已在 `src/codex.ts` 修好）：flags 必须在 `resume` 子命令之前；
  非 git 工作区必须 `--skip-git-repo-check`；spawn 时 stdin 必须 ignore（否则等 EOF 挂住）。
- **文件桥**：顶栏 📎「工作区文件」——拖拽/选择上传（落进 `/opt/codex-agent/workspace`，
  agent 直接能读）、列表点「下载」取回 agent 生成的文件。接口 `POST /api/upload`（50MB 上限）、
  `GET /api/files`、`GET /api/files/<name>`。安全在 `src/files.ts`：文件名一律 basename 净化，
  落地前 resolve 校验仍在 workspace 内（路径穿越串被压平，不逃逸）。只在 workspace 顶层平铺。
- **部署**：`bash deploy.sh`（test + build → rsync → 重启）。首次开服 `deploy/provision.sh`。
  注意 `package.json` test 用 `--test-force-exit`（undici keep-alive 会让 node 测试进程不退）。
- **排查**：`ssh root@66.42.45.128 'journalctl -u codex-agent -n 50 --no-pager'`；
  事件 schema 变了就重录 `test/fixtures/real-events.jsonl`（录法见 fixture.test.ts 注释）校准。
- **密码**：网页密码在 iCloud「账户和密码」文档；轮换方法同 lab（caddy hash-password →
  改 Caddyfile codex 段 → reload）。订阅 ToS 单用户，不分享。

设计 spec：`../docs/superpowers/specs/2026-07-05-codex-agent-vps-design.md`
实施计划：`../docs/superpowers/plans/2026-07-05-codex-agent-vps.md`
