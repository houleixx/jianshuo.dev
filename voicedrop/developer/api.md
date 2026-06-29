# VoiceDrop API

VoiceDrop 后端由 **三个独立的 HTTP 服务** 组成，都跑在 Cloudflare 上、同挂 `jianshuo.dev` 这个 zone。一个客户端通常只跟前两个打交道。

| 服务 | Base URL | 用途 |
|---|---|---|
| **Files API** | `https://jianshuo.dev/files/api/` | 账户、录音/文章文件、分享、公众号、社区。绝大多数调用在这里。 |
| **Agent Worker** | `https://jianshuo.dev/agent/`（WS：`wss://jianshuo.dev/agent/`） | 触发挖矿、实时状态推送、语音改稿。 |
| **Reco Worker** | `https://jianshuo.dev/reco/` | 社区 feed 排序 + 互动上报。可随时拔掉，挂了不影响主流程。 |

> 每个服务都另有一个 `*.jianshuo.workers.dev` 镜像（`voicedrop-agent.jianshuo.workers.dev`、`voicedrop-reco.jianshuo.workers.dev`），行为一致。同 zone 内服务端互调用镜像绕过 Pages 路由；客户端用上面的 `jianshuo.dev/...` 即可。

**数据流一句话**：上传 `.m4a` → 服务端挖矿（ASR + Claude）写出 `articles/<stem>.json` → 客户端读文章、分享、发公众号 / 发社区。

---

## 1. 认证

所有请求用 `Authorization: Bearer <token>`（Files API 也接受 `?token=<token>` 查询参数）。共两档凭证：

| 凭证 | 形态 | 怎么拿 | scope（数据隔离） |
|---|---|---|---|
| **anon token** | `anon_` 开头、≥20 位的高熵字符串 | 客户端自己生成一次，存好（同一个用户始终用同一个 token） | `users/anon-<sha256(token)[:32]>/` |
| **session JWT** | `h.p.sig`（HS256） | `POST auth/apple` 用 Apple identityToken 换 | JWT 内的 `scope` |

**关键点：**
- **scope 决定你能看到谁的数据。** 你的所有相对 key 都会被自动拼到 `scope` 前缀下，无法越界（`..`、绝对路径一律拒）。
- **anon 与 session 解析到同一个用户。** Apple 登录只是把 Apple ID *绑定* 到你当前那个 anon 数据盒上——session 的 scope 本身就是 `users/anon-<hash>/`。所以一个用户用 anon 还是 session 调，落到同一份数据。
- **多数接口任意有效 token 都能调。** 只有 **写社区（share / unshare）** 要求 Apple 验证过的 session JWT，否则 `403 needs_apple_signin`。
- 另有一种 24h **只读 temp token**（`GET token/articles` 签发），只能 `list` / `download`。Reco 与 Agent **不接受** temp token。

### 换 session JWT

```
POST /files/api/auth/apple
Content-Type: application/json

{ "identityToken": "<Apple identity token>", "fullName": "张三", "email": "..." }
```
`fullName` / `email` 仅首次授权时由 Apple 下发，可选。带上当前的 anon token（`Authorization` 头）则把这个 Apple ID 绑到该 anon 盒，数据不搬家。

返回：`{ "session": "<JWT, 有效期 365 天>", "scope": "users/<sub>/" }`

---

## 2. 通用约定

- **请求 / 响应体都是 JSON**（文件上传 / 下载除外）。
- **错误**：非 2xx 一律返回 `{ "error": "<code>", ... }`。常见状态码：

  | 码 | 含义 |
  |---|---|
  | 400 | 参数 / key 非法 |
  | 401 | token 缺失或无效 |
  | 403 | 权限不足（只读 token 越权、非 owner、社区写未登录 Apple） |
  | 404 | 资源不存在 |
  | 409 | 未配置（如公众号未填 AppID/Secret → `wechat_not_configured`） |
  | 502 | 上游失败（公众号 relay / 真实 WeChat errcode 透传） |

- **路径约定**（容易混，重点看）：

  | 接口家族 | 你传的标识符 | 例子 |
  |---|---|---|
  | 文件类（`list`/`download`/`upload`/`file`） | **scope 内相对路径** | `VoiceDrop-xxx.m4a`、`articles/xxx.json` |
  | `share` / `wechat` / `community/*` | **相对文章 key** | `articles/<stem>.json` |
  | Articles API（`/articles/...`） | **stem**（纯文件名，不带 `articles/` 前缀、不带 `.json`） | `VoiceDrop-xxx` |
  | `photo` / `asset`（公开） | **完整 R2 key** | `users/<sub>/photos/.../x.jpg` |

---

## 3. Files API

> 除 `auth/apple`、`photo/*`、`asset/wechat-covers/*` 外，全部需要 token。

### 账户

| 方法 / 路径 | 说明 | 返回 |
|---|---|---|
| `POST auth/apple` | 见上 | `{session, scope}` |
| `GET whoami` | 当前 token 解析出的 scope | `{scope:"users/<sub>/"}` |
| `GET token/articles` | 签发 24h 只读文章链接 | `{token, url, expires_in:86400}` |

### 文件（裸 R2 读写）

| 方法 / 路径 | 说明 | 返回 |
|---|---|---|
| `GET list` | 列出 scope 内全部对象（已分页聚合，不截断） | `{files:[{name,size,uploaded}]}` |
| `PUT upload/<name>` | 上传（请求体即文件原始字节，`Content-Type` 透传）。**`name` 形如 `VoiceDrop-*.m4a` 时自动触发挖矿。** | `{ok:true, name}` |
| `GET download/<name>` | 下载原始字节。`HEAD` 同路径只取元信息。 | 文件字节 |
| `DELETE file/<name>` | 删除单个对象 | `{ok:true}` |

**录音文件名约定**：`VoiceDrop-<ts>-<dur>-<weekday>-<period>[-<city>-<district>].m4a`（纯 ASCII）。只有这个前缀+后缀会触发自动挖矿。

### 文章（高层 CRUD，自带版本控制）

`<stem>` = 录音文件去掉后缀的主名。**优先用这组接口而不是裸 `download/articles/<stem>.json`**——它会把内部版本结构（`versions[head]`）拍平成顶层 `articles`。

| 方法 / 路径 | 说明 | 返回 |
|---|---|---|
| `GET articles` | 列出全部文章 | `{articles:[{stem,title,head,createdAt,updatedAt,count}]}` |
| `GET articles/<stem>` | 读一篇（当前 head 版本） | 文章文档（见 §6） |
| `PUT articles/<stem>` | 写入（自动存为新版本） | `{ok, head}` |
| `DELETE articles/<stem>` | 删文章 + `.srt` + `.empty` 边车 | `{ok}` |
| `GET articles/<stem>/history` | 版本历史 | `{head, versions:[...]}` |
| `PATCH articles/<stem>/head` | 只移动 head 指针（撤销 / 重做，不产生新版本），body `{head:<n>}` | `{ok, head}` |
| `PUT articles/<stem>/srt` | 写字幕边车（请求体为 SRT 文本） | `{ok}` |
| `PUT articles/<stem>/empty` | 标记无语音，body `{reason?}` | `{ok}` |

### 分享 & 公众号

| 方法 / 路径 | 说明 | 返回 |
|---|---|---|
| `GET share/articles/<stem>.json` | 生成 / 取该文章的公开短链 | `{url:"https://jianshuo.dev/voicedrop/<id>"}` |
| `POST wechat/articles/<stem>.json` | **同步**把文章发成公众号草稿（已发过则原地更新）。需先配好 `WECHAT.json`。 | `{ok,created,updated}`；`409 wechat_not_configured`；`502 {errcode,errmsg}` 透传真实微信错误 |

### 社区（跨用户公共空间）

帖子是 **指向某篇文章的活指针**（schema-2，无内容拷贝）——源文章一改，社区里立即同步。

| 方法 / 路径 | 说明 | 返回 |
|---|---|---|
| `POST community/share/articles/<stem>.json` | 分享 / 重新分享自己的一篇。body 可带 `{replyTo:<shareId>}` 表示回复。**需 Apple session**，否则 `403 needs_apple_signin`。 | `{ok, shareId}` |
| `GET community/list` | 全部帖子，按首次分享时间倒序 | `{posts:[{shareId,author,title,firstSharedAt,count,mine,replyTo?}]}` |
| `GET community/get/<shareId>` | 读一帖（含活文章内容） | `{shareId,author,title,articles:[{title,body}],owner,firstSharedAt,replyTo?}` |
| `GET community/replies/<shareId>` | 某帖的回复，按时间正序 | `{posts:[...]}` |
| `GET community/shared/articles/<stem>.json` | 我这篇是否已分享（驱动「分享 / 更新」按钮） | `{shared:bool, shareId?}` |
| `POST community/unshare/<shareId>` | 撤下自己的帖（**owner only**） | `{ok}` |

> 渲染社区帖里的照片：用返回的 `owner` 拼上正文里 `[[photo:<relkey>]]` 标记的 key，得到完整 key，再走下面的公开 `photo/<key>` 取图。

### 公开资源（无需 token）

| 方法 / 路径 | 说明 |
|---|---|
| `GET photo/<完整 R2 key>` | 取一张会话照片。只接受 `users/*/photos/*.(jpg\|jpeg\|png)`，CORS `*`、公开缓存。**所有照片展示都走这个唯一端点。** |
| `GET asset/wechat-covers` | 列出公众号封面图名 → `{covers:[...]}` |
| `GET asset/wechat-covers/<name>` | 取一张封面图字节 |

---

## 4. Agent Worker

Base：`https://jianshuo.dev/agent/`。鉴权同 Files API（anon 或 session，**编辑需可写 token**）。

### 触发挖矿

```
POST /agent/mine/trigger
Authorization: Bearer <any valid user token>
```
唤醒服务端 miner 处理所有待处理录音。幂等，已处理的会跳过。返回 `202 queued`。上传 `.m4a` 时服务端已自动调，一般无需手动。

### `wss://…/agent/edit?stem=<stem>` — 语音改稿

打开后是一条长连接，可多轮往返；服务端按文章持久化历史，跨轮有上下文。

**客户端 → 服务端**（发改稿指令）：
```json
{
  "type": "instruct",
  "text": "把第3行改简洁点，删掉图2",
  "images": [
    { "data": "<base64>", "key": "photos/<sessionTs>/<offset>-<rand>.jpg", "mediaType": "image/jpeg" }
  ]
}
```
（`images` 可选，附带新照片。）

**服务端 → 客户端**（每条指令依次推这些）：
```json
{ "type": "status",  "state": "working" }
{ "type": "updated", "article": { ... 顶层 articles 的完整文档 } }
{ "type": "reply",   "text": "改好了", "ok": true }
{ "type": "error",   "message": "<原因>" }
```
- `status`：开始处理。
- `updated`：已写回 R2，请用它原地刷新。
- `reply`：口头确认（`text` 可能为空）。
- `error`：失败；本条指令未生效。

**协议规则（客户端必须遵守）：**
- **严格串行**：上一条 `instruct` 收到 `updated` 之前，不要发下一条。服务端正忙时会回 `{"type":"error","message":"正在修改，请稍候"}`。
- 一次成功的指令固定先 `status` → 再 `updated` →（多数情况）`reply`。拿到 `updated` 即可认为本轮文章已落库。
- 正文里 `[[photo:<key>]]` 标记 = 配图位置，key 就是照片的相对 R2 key。改稿时这些标记会被原样保留。
- 用户可用「第N行 / 图N」指代位置：第N行 = 正文按真实换行拆开后第 N 个非空行（图片标记自己占一行）；图N = 正文里第 N 个出现的照片标记。

### `wss://…/agent/status` — 实时状态推送

只读订阅，**客户端不发消息**。每当某条录音状态变化，服务端推：
```json
{ "type": "status_update", "stem": "VoiceDrop-xxx", "status": "asr" }
```
`status` 取值：`asr`（听录音）· `mining`（挖文章）· `ready`（已成文）· `empty`（无语音）。据此把列表行的徽章原地翻状态，免轮询。

---

## 5. Reco Worker

Base：`https://jianshuo.dev/reco/`。鉴权：anon 或 session token（**不接受** temp token）。可拔掉——**客户端应自带 2s 超时，reco 挂 / 超时就回退按时间倒序**，feed 照常。

### `POST /reco/rank` — feed 排序

把 `GET community/list` 拿到的帖子交给 reco 排序。请求：
```json
{ "posts": [ { "shareId":"abc", "firstSharedAt":1700000000000, "replyCount":2, "author":"张三" } ] }
```
返回：
```json
{ "order": ["<shareId>", "..."],
  "liked": ["<shareId>", "..."] }
```
`order` = 排好序的 shareId；`liked` = 当前用户点过 ❤️ 的。评分 = `(1 + view·1 + finish·4 + like·3 + reply·5 + report·(-9)) / (ageHours+2)^1.5`，再按作者打散。

### `POST /reco/engage/<shareId>` — 互动上报（fire-and-forget）

```json
{ "action": "view" }
```
`action` ∈ `view`（进帖）· `finish`（读到底）· `like`（❤️）· `report`（举报）。
- 每用户每动作去重；`view` / `finish` / `report` 一次性、不累计。
- **`like`** 带 `{"action":"like","on":false}` 表示取消赞；返回 `{ok, liked:<bool>}`。其它返回 `{ok}`。
- **`report`** 不可撤销、负权重，一个举报即可把冷启动帖压到沉底。
- D1 不可用时整体降级为 no-op，永不报错。

---

## 6. 数据模型

### 文章文档（`GET articles/<stem>` 返回）

```json
{
  "schema": 3,
  "id": "VoiceDrop-xxx",
  "sourceAudio": "VoiceDrop-xxx.m4a",
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000,
  "transcript": "原始口述转写……",
  "srt": "1\n00:00:00,000 --> ...",
  "status": "ready",
  "model": "claude-sonnet-4-6",
  "articles": [ { "title": "标题", "body": "正文 markdown，含 [[photo:<relkey>]] 标记" } ]
}
```
- **`articles` 是当前 head 版本拍平的结果**；内部 `versions` / `head` 不在此返回（用 `/history` 查）。
- 文章**存在** = `articles/<stem>.json` 存在 = 已成文。
- 文章处理后**无语音** = 同目录有 `articles/<stem>.empty`（`{status:"empty",reason:"..."}`）。
- **照片**只靠正文里的 `[[photo:<relkey>]]` 标记引用，没有单独的 photos 数组。`<relkey>` 是 scope 内相对 key，拼上 `whoami` / `owner` 的 `users/<sub>/` 前缀即得完整 key，走公开 `photo/<key>` 取图。

### R2 key 速查（均在 `users/<sub>/` 下）

| key | 内容 |
|---|---|
| `VoiceDrop-<ts>-….m4a` | 录音（上传它触发挖矿） |
| `articles/<stem>.json` | 文章（存在 = 已成文） |
| `articles/<stem>.empty` | 无语音标记 |
| `articles/<stem>.srt` | 字幕边车 |
| `photos/<sessionTs>/<offset>-<rand>.jpg` | 会话照片（`<offset>` = 距录音起点的整数秒） |
| `CLAUDE.md` | 用户名字 + 文风（喂给挖矿/改稿 prompt） |
| `WECHAT.json` | 公众号配置 `{appid,secret,enabled,coverMediaIds}` |

---

## 7. 端到端示例（cURL）

```bash
TOKEN="anon_xxxxxxxxxxxxxxxxxxxx"
BASE="https://jianshuo.dev/files/api"

# 1) 上传录音（自动触发挖矿）
curl -X PUT "$BASE/upload/VoiceDrop-20260627-093012-Sat-morning.m4a" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: audio/m4a" \
  --data-binary @rec.m4a

# 2)（可选）手动催一把挖矿
curl -X POST "https://jianshuo.dev/agent/mine/trigger" \
  -H "Authorization: Bearer $TOKEN"

# 3) 列文章，读一篇
curl "$BASE/articles" -H "Authorization: Bearer $TOKEN"
curl "$BASE/articles/VoiceDrop-20260627-093012-Sat-morning" -H "Authorization: Bearer $TOKEN"

# 4) 生成公开分享短链
curl "$BASE/share/articles/VoiceDrop-20260627-093012-Sat-morning.json" \
  -H "Authorization: Bearer $TOKEN"

# 5) 发成公众号草稿（需先配 WECHAT.json）
curl -X POST "$BASE/wechat/articles/VoiceDrop-20260627-093012-Sat-morning.json" \
  -H "Authorization: Bearer $TOKEN"
```

实时进度可订阅 `wss://jianshuo.dev/agent/status`（带同一个 `Authorization`），看着这条录音的徽章从 `asr` → `mining` → `ready` 翻过去。
