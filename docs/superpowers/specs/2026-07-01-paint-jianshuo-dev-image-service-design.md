# paint.jianshuo.dev —— Codex 订阅版 gpt-image-2 图片服务

- 日期：2026-07-01
- 状态：设计已确认，待写实现计划
- 范围：**只做图片服务本体**（网页 + HTTP API + 回调）。VoiceDrop 口述编辑图片的接线是另一个 spec。

## 1. 目标 / 非目标

### 目标
- 在 Tokyo VPS（`66.42.45.128`）上常驻一个服务，外壳照抄现有的 `claude-agent`（Caddy HTTPS + 密码 + systemd）。
- 用 **Codex 订阅**（`~/.codex/auth.json`，不花 API 钱）跑 gpt-image-2，底层复用现成的 `gpt-image-2-skill --provider codex` CLI。
- 两个入口，同一后端：
  - **网页**（给王建硕手动用）：上传图 + 输入提示词 → 看实时进度 → 出图可下载 + 历史画廊。
  - **HTTP API**（给 skill / VoiceDrop 程序调）：提交任务拿 `job_id`，异步出图。
- 支持两种形态：**有图 = 改图（edit）**，**无图 = 文生图（generate）**。
- **异步 + 回调（webhook）是主线**：调用方提交任务时带上 `callback_url` + `callback_meta`（任意参数，原样回传）；出图后服务 POST 回调，把 `result_url` 和 `callback_meta` 一起送回去。轮询和 SSE 作为兜底/进度手段。

### 非目标（本 spec 不做）
- 不做 VoiceDrop 侧的「口述编辑图片」功能、不碰 R2、不改笔记结构 —— 那是下一个 spec。图片服务**保持通用/无脑**，不认识任何具体业务。
- 不做真正的 OpenAI Agents SDK / agent loop —— Agents SDK 只认 `OPENAI_API_KEY`（按量付费），够不到 Codex 订阅；而且「提示词+图→结果」是一次性请求，不需要 agent loop。
- 不做多用户 / 账号系统。Codex 订阅按 ToS 是单用户，服务只服务王建硕本人（密码 + token 门禁）。

## 2. 架构

```
┌─────────── 浏览器（王建硕手动用）───────────┐        ┌──── skill / VoiceDrop Worker ────┐
│  上传图 + prompt → SSE 看进度 → 出图/历史   │        │  POST 任务 + callback_url/meta    │
└───────────────┬─────────────────────────────┘        └───────────────┬──────────────────┘
                │ (Caddy basic_auth)                                    │ (Bearer token)
                ▼                                                       ▼
        ┌──────────────────────── Caddy (HTTPS, paint.jianshuo.dev) ────────────────────────┐
        │  /            → basic_auth → Node (网页 HTML)                                       │
        │  /results/*   → 直接静态（不加密，靠不可猜的随机 id）                                │
        │  /api/*       → Node（Bearer token 校验）                                           │
        └───────────────────────────────────┬──────────────────────────────────────────────┘
                                             ▼  127.0.0.1:8788
                         ┌────────────────── Node 服务（systemd: paint.service）─────────────┐
                         │  HTTP 层：/api/jobs, /api/jobs/:id, /api/jobs/:id/events(SSE)      │
                         │  Job 存储：SQLite（jobs 表）                                        │
                         │  Worker：并发池(2~3) → spawn gpt-image-2-skill --provider codex    │
                         │          解析 stderr JSONL 进度 → SSE；解析 stdout --json 结果       │
                         │          出图落盘 /opt/paint/results/<id>.<ext>                     │
                         │  回调器：POST callback_url（带重试 + 可选 bearer + HMAC 签名）        │
                         └───────────────────────────────────┬──────────────────────────────┘
                                                             ▼
                                    gpt-image-2-skill（npm 全局）→ Codex responses 端点
                                    认证：CODEX_HOME=/opt/paint/.codex/auth.json（订阅，401 自动刷新）
```

### 组件边界（各自单一职责）
- **HTTP 层**：解析请求、鉴权、建 job、返回 `job_id`、SSE 转发、静态服务结果图。不碰图像生成细节。
- **Job 存储（SQLite）**：job 的唯一真源，进程重启不丢。字段见 §6。
- **Worker（并发池）**：把 job 变成对 `gpt-image-2-skill` 的一次子进程调用；解析进度与结果；落盘。不懂 HTTP、不懂回调协议。
- **回调器**：出图后把结果送到 `callback_url`；带重试与签名。不懂图像生成。
- **图像引擎**：就是外部 `gpt-image-2-skill` CLI，本服务只当它是黑盒子命令。

## 3. 部署拓扑（照抄 claude-agent）

- 代码目录：`~/code/jianshuo.dev/paint/`（`src/` TS 服务 + `public/` 单文件浅色 UI + `deploy/`）。加进根目录 `.assetsignore` + `.pagesignore`，不影响 jianshuo.dev 主站和 Pages。
- 子域：`paint.jianshuo.dev`，Cloudflare **灰云** A 记录 → `66.42.45.128`（不走 Pages，跟 lab.jianshuo.dev 一样）。
- 机器：同一台 Tokyo VPS（`66.42.45.128`，1 核 1GB），与 `claude-agent`、`wechat-publish-proxy` 共存。
- 进程：systemd `paint.service`，非特权用户 `paint`，`Restart=always` + enabled + systemd 沙箱化，监听 `127.0.0.1:8788`（claude-agent 占 8787），工作目录 `/opt/paint/`。
- 前置：Caddy 反代 + 自动 Let's Encrypt HTTPS。路由分三类见 §2 图与 §9。
- 技术栈：Node 20 + TypeScript（与 claude-agent 一致）。依赖尽量少：`better-sqlite3`（job 存储）、`busboy`（multipart 上传）。其余用 Node 内置 http/https/crypto。
- 部署脚本：`paint/deploy.sh`（本地 `tsc` build → rsync → VPS `npm ci` → 重启）；首次 `deploy/provision.sh`（装 Node20/Caddy、建用户/目录/unit、`npm i -g gpt-image-2-skill`、放 auth.json）。

### Codex 认证落地（关键，易踩坑）
- 把本机 `~/.codex/auth.json` 拷到 VPS `/opt/paint/.codex/auth.json`（权限 600，owner=`paint`）。
- 服务进程环境设 `CODEX_HOME=/opt/paint/.codex`，让 CLI 从这里读 auth，并把 **401 刷新后的新 token 写回同一文件**（必须是 `paint` 用户可写的持久目录，否则重启后 token 失效）。
- 单用户订阅（Anthropic/OpenAI ToS 同理）：不共享、不做多用户；风险见 §13。

## 4. HTTP API 契约

所有 `/api/*` 需 `Authorization: Bearer <API_TOKEN>`。请求体支持两种：
- `application/json`：图片用 `image_url`（服务去下载）或 `image_b64`（base64）。
- `multipart/form-data`：文件字段 `image` + 其余字段（网页上传用）。

### POST /api/jobs
提交一个生成/编辑任务，**立刻**返回，不阻塞。

请求字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 提示词（画什么 / 怎么改）|
| `image_url` / `image_b64` / multipart `image` | 否 | 传了 = 走 edit（改图），不传 = 走 generate（文生图）|
| `size` | 否 | `2K`（默认）/ `4K` / `WxH`（边为 16 的倍数，最长边 ≤3840，≤8.29M 像素，宽高比 ≤3:1）|
| `format` | 否 | `png`（默认）/ `jpeg` / `webp` |
| `quality` | 否 | `low` / `medium` / `high` / `auto`（默认 `high`）|
| `compression` | 否 | `0..100`（jpeg/webp）|
| `transparent` | 否 | `true` → 走 `transparent generate`（本地抠图流程，仅 generate；见 §8 说明）|
| `callback_url` | 否 | 出图后 POST 到这里（见 §5）|
| `callback_token` | 否 | 回调时作为 `Authorization: Bearer` 发给 `callback_url`（调用方自控密钥）|
| `callback_meta` | 否 | 任意 JSON，原样回传（VoiceDrop 用它装 `{note_id, orig_key}`）|

> Codex provider 不认 `--background/--n/--mask/--moderation/--input-fidelity`；这些字段本服务直接不暴露。`transparent=true` 走另一条命令组，见 §8。

响应 `202`：
```json
{ "job_id": "b3f1c2a4-...", "status": "queued", "poll_url": "/api/jobs/b3f1c2a4-...", "events_url": "/api/jobs/b3f1c2a4-.../events" }
```

### GET /api/jobs/:id
轮询兜底。
```json
{
  "job_id": "b3f1c2a4-...",
  "status": "queued | running | done | failed",
  "percent": 0..100,
  "result_url": "https://paint.jianshuo.dev/results/b3f1c2a4-....png",   // done 时
  "format": "png", "size": "2048x2048", "bytes": 1574879,
  "error": null,                                                        // failed 时填 { code, message }
  "created_at": "...", "done_at": "..."
}
```

### GET /api/jobs/:id/events  (SSE)
给网页看实时进度。把 `gpt-image-2-skill` 的 stderr JSONL 事件转成 SSE：
- 转发 `kind != "sse"` 的进度事件（`request_started` 0% → `request_completed` 95% → `output_saved` 100%，含 `retry_scheduled`）。Codex 的原始 SSE 噪声默认过滤掉。
- 终态发一条 `done`（带 `result_url`）或 `failed`（带 error）后关闭。
- 客户端断开：监听 `res` 的 close（不是 `req`），清理订阅（照抄 claude-agent 的教训）。

### GET /api/jobs?limit=N
历史列表（网页画廊用），返回最近 N 条 job 的精简记录。

### GET /results/:file
静态结果图。**不加密**，靠 uuid 随机文件名不可猜（同 jianshuo.dev/files 中转站思路）；这样 VoiceDrop / 网页 直接 GET，无需带凭据。保留期见 §10。

## 5. 回调契约（VoiceDrop 消费的核心）

Worker 出图（成功或失败）后，如果 job 带了 `callback_url`，回调器就 `POST callback_url`：

Headers：
- `Content-Type: application/json`
- `Authorization: Bearer <callback_token>`（若提交时给了 `callback_token`）
- `X-Paint-Signature: sha256=<hmac(body, CALLBACK_SIGNING_SECRET)>`（服务级共享密钥，接收方可校验来源真伪）
- `X-Paint-Job: <job_id>`（幂等去重用）

Body：
```json
{
  "job_id": "b3f1c2a4-...",
  "status": "done | failed",
  "result_url": "https://paint.jianshuo.dev/results/b3f1c2a4-....png",
  "format": "png",
  "size": "2048x2048",
  "bytes": 1574879,
  "error": null,
  "callback_meta": { "note_id": "...", "orig_key": "..." }   // 原样回传
}
```

投递策略：
- 重试最多 3 次，指数退避（1s → 2s → 4s）；非 2xx 视为失败重试。
- 每次投递结果记进 job 记录（`callback_status`, `callback_attempts`, `last_callback_at`）。
- 幂等：接收方按 `job_id` 去重（回调可能重复送达）。

> 这就是「带参数的 callback function」：调用方把 `callback_meta` 塞进去，出图后原样回来，回调处理器凭它知道该更新哪条笔记、哪张原图。图片服务本身完全不需要懂这些字段的含义。

## 6. Job 生命周期与存储

SQLite 表 `jobs`：

| 列 | 说明 |
|---|---|
| `id` (uuid, PK) | job_id，也是结果文件名前缀 |
| `status` | `queued` / `running` / `done` / `failed` |
| `mode` | `generate` / `edit` |
| `prompt` | 提示词 |
| `params_json` | size/format/quality/compression/transparent 等 |
| `input_path` | 输入图落盘路径（edit 时）|
| `result_path`, `format`, `bytes`, `size` | 结果 |
| `percent` | 进度 |
| `error_json` | 失败原因 `{code,message}` |
| `callback_url`, `callback_token`, `callback_meta_json` | 回调参数 |
| `callback_status`, `callback_attempts`, `last_callback_at` | 回调投递状态 |
| `created_at`, `started_at`, `done_at` | 时间戳 |

生命周期：
1. `POST /api/jobs` → 落 `input`（下载 `image_url` / 解 `image_b64` / 存 multipart 文件）→ 插入 `queued` 记录 → 返回 `job_id`。
2. Worker 并发池（`MAX_CONCURRENCY=3`，因为耗时几乎全在等 OpenAI 出图，本机 I/O-bound）取 job → `running`。
3. spawn `gpt-image-2-skill`，`--json --json-events`；边读 stderr JSONL 更新 `percent` + 推 SSE。
4. 进程退出：解析 stdout `--json`；成功 → 结果图落 `/opt/paint/results/<id>.<ext>`，写 `done`；失败 → 写 `failed` + error。
5. 若有 `callback_url` → 交回调器投递（§5）。
6. 进程重启恢复：启动时把仍是 `running`/`queued` 的 job 重新入队（幂等，结果文件按 id 覆盖）。

## 7. 网页（给王建硕手动用）

单文件浅色 UI（照抄 claude-agent 的 `public/index.html` 风格，白底浅色，符合用户偏好）：
- 一个提示词输入框 + 拖拽/选择图片（可空 = 文生图）+ size/format/quality/透明底 选择。
- 「生成」→ `POST /api/jobs`（multipart）→ 拿 `job_id` → 连 SSE 显示进度条 + 事件日志 → 出图后大图预览 + 下载按钮。
- 下方「历史」画廊：`GET /api/jobs?limit=50`，缩略图网格，点开看大图 / 复制 `result_url`。
- 页面由 Node 服务时把 `API_TOKEN` 注入进 HTML（页面已在 Caddy basic_auth 之后，token 不外泄），前端 fetch `/api/*` 带上它。

## 8. 图像引擎调用（gpt-image-2-skill）

VPS 上 `npm i -g gpt-image-2-skill`，服务 spawn 全局 `gpt-image-2-skill`。环境带 `CODEX_HOME=/opt/paint/.codex`。

- **文生图（generate）**：
  ```
  gpt-image-2-skill --json --json-events images generate \
    --provider codex --prompt "<prompt>" --out <results/id.ext> \
    --format <png|jpeg|webp> --size <2K|4K|WxH> --quality <q>
  ```
- **改图（edit）**：
  ```
  gpt-image-2-skill --json --json-events images edit \
    --provider codex --prompt "<prompt>" --ref-image <input_path> \
    --out <results/id.ext> --format <...> --size <...> --quality <...>
  ```
- **透明底（transparent=true，仅 generate）**：Codex 不认 `--background`，真透明要走本地抠图命令组：
  ```
  gpt-image-2-skill --json --json-events transparent generate \
    --provider codex --prompt "<prompt>" --out <results/id.png> --size <...> --quality high
  ```
  edit + transparent 组合 v1 暂不支持（需受控 matte 流程，复杂），请求里出现则返回 400。

输出解析：
- **结果**：读子进程 **stdout** 的 `--json` 信封（成功含 `output.path/bytes`，失败含 error code/message）。
- **进度**：读 **stderr** 的 JSONL（一行一事件），映射到 `percent` 并转 SSE。
- 重试：CLI 自带最多 3 次退避 + Codex 401 自动刷新一次；本服务不重复重试生成，只在**回调投递**层面做重试。

## 9. 鉴权与安全

| 路径 | 保护 |
|---|---|
| `/`（网页 HTML）| Caddy `basic_auth`（用户 `wjs`，密码存 iCloud「账户和密码」文档，不进 repo）。页面加载后从注入的 token 调 `/api/*` |
| `/api/*`（提交/查询/SSE/历史）| Node 校验 `Authorization: Bearer <API_TOKEN>`。网页从注入的 token 取；skill/VoiceDrop 用配好的 token |
| `/results/*` | 公开可读，靠 uuid 不可猜；30 天过期 |
| 出站回调 | 服务用 `callback_token`（调用方自控）+ `X-Paint-Signature` HMAC（服务级密钥）双重让接收方可信任 |

- 输入校验：`image_url` 只允许 http(s)；下载设大小上限（如 ≤25MB）与超时；`prompt` 长度上限。
- 密钥都放 `/opt/paint/.env`（600）：`API_TOKEN`、`CALLBACK_SIGNING_SECRET`、`PORT`、`MAX_CONCURRENCY`、`PUBLIC_BASE_URL=https://paint.jianshuo.dev`、`RESULT_RETENTION_DAYS=30`、`CODEX_HOME`。

## 10. 存储与保留

- 输入图：`/opt/paint/inputs/<id>.<ext>`，job 完成后可即时删（省空间）。
- 结果图：`/opt/paint/results/<id>.<ext>`，公开 URL。
- 保留：每天清理超过 `RESULT_RETENTION_DAYS`(默认 30) 的结果 + 对应 job 记录（systemd timer 或进程内定时器）。清理时 `log` 删了多少，别静默。

## 11. 错误处理

- 提交阶段：缺 `prompt`、`image_url` 拉取失败、参数非法 → `400`，不建 job。
- 生成失败：CLI 非 0 退出或 stdout error 信封 → job `failed` + `{code,message}`；SSE 发 `failed`；有回调则回调 `status:"failed"`。
- Codex 认证失效（刷新也失败）：job `failed`，error code `auth_failed`；`log` 到 journal 提醒补 auth.json。
- 回调不可达：重试 3 次仍失败 → 记 `callback_status:"failed"`，job 本身仍是 `done`（结果图在，可查询/网页看到）。

## 12. 测试

- **单元**：参数校验、gpt-image-2-skill 命令行拼装（generate/edit/transparent 三种）、stderr JSONL → percent 映射、HMAC 签名。
- **引擎打桩**：用一个假的 `gpt-image-2-skill`（吐预置 JSONL 到 stderr + JSON 到 stdout）跑通 job 全流程，不真花 Codex 额度。
- **回调**：起个本地 HTTP 接收端，验证 body/签名/`callback_meta` 原样回传 + 重试。
- **路由级**：`POST /api/jobs` → 轮询到 `done` → `GET result_url` 拿到文件（用打桩引擎）。
- **冒烟（手动，真 Codex）**：部署后网页跑一次 generate + 一次 edit，确认订阅计费、出图正常。

## 13. 风险 / 待确认

- **Codex token 持久化**：401 刷新后的新 token 必须写回 `/opt/paint/.codex/auth.json`（`paint` 用户可写）。若 CLI 只认 `~/.codex`，需确认 `CODEX_HOME` 是否被尊重；否则改用软链或定期从本机同步。**实现前先在 VPS 上 `auth inspect` 验证一次。**
- **订阅 ToS 单用户**：服务仅本人用，密码 + token 别外泄。
- **1 核 1GB 并发**：生成是等 OpenAI，I/O-bound，`MAX_CONCURRENCY=3` 应无压力；但下载大输入图 + sharp/文件写入仍占内存，上线后观察 journal。
- **透明底 edit**：v1 不支持，先返回 400，够用再说（YAGNI）。
- **CLI 版本漂移**：provision 时 `npm i -g gpt-image-2-skill@latest`；命令 flag 以 VPS 上实际 `--help` 为准，实现时核对一遍。

## 14. 后续（不在本 spec）

- **VoiceDrop 口述编辑图片**（下一个 spec）：VoiceDrop Worker（`agent/`）加一个工具/流程 —— 口述「把这张图改成广告」→ `POST paint.../api/jobs`（`image_url`=笔记图，`prompt`=口述，`callback_url`=Worker 回调路由，`callback_meta={note_id, orig_key}`）→ Worker 回调处理器拉 `result_url` → 写 R2 新文件名 → 改笔记文本指针。R2 读写走 `functions/files/api/`，回调路由是 Worker 新增端点。
- 可能的增强：edit+透明、多图 `n`（换 OpenAI provider 时才有意义）、结果转存 R2。
