# VoiceDrop MCP Server

把 VoiceDrop 整个账号包成一个 [MCP](https://modelcontextprotocol.io) server：任何 MCP 客户端
（Claude Code、Claude 桌面/手机 App、ChatGPT…）连上以后，就能读写文章、改文风、触发挖矿、
逛社区、投币、查算力、发公众号——不用再手搓 curl。

## 端点

```
https://voicedrop.cn/mcp              ← 主入口（备案接入点，国内可达）
https://jianshuo.dev/voicedrop/mcp    ← 同一个东西
```

传输是 **streamable HTTP，无状态**——每个 POST 自成一体，不存 session。

## 接上去

先在 VoiceDrop App 的 **设置 → 账户 → 访问令牌** 里复制 token，然后：

**Claude Code**

```bash
claude mcp add voicedrop --transport http https://voicedrop.cn/mcp \
  --header "Authorization: Bearer <你的 token>"
```

**其它客户端**（Claude 桌面版自定义连接器等）：URL 填 `https://voicedrop.cn/mcp`，
自定义头填 `Authorization: Bearer <你的 token>`。

## 认证

server 是**纯代理，不持有任何凭证**——你的 token 原样透传给 VoiceDrop，服务端不落盘、不缓存。

四种 token 都能用，但能干的事不一样：

| token | 从哪来 | 限制 |
|---|---|---|
| **anon**（`anon_…`） | App 设置里复制 | 不能写社区、不能投币（会提示去登录） |
| **Apple / 微信 session** | App 里登录后复制 | 全功能 |
| **管理员**（`FILES_TOKEN`） | 只有王建硕有 | 大部分工具能用，但社区分享会被拒 |
| **24 小时只读** | `GET /files/api/token/articles` | 只能列出和下载 |

`initialize` 和 `tools/list` 不需要 token（客户端要先看得见有什么工具）；
只有 `tools/call` 必须带。

## 31 个工具

| 类 | 工具 |
|---|---|
| **文章** | `list_articles` `read_article` `write_article` `article_history` `set_article_version` `delete_article` |
| **文风** | `read_style` `write_style` `style_history` `set_style_version` `collect_style_sample` `list_style_dataset` `extract_style` |
| **挖矿** | `trigger_mining` `restyle_article` |
| **社区** | `community_feed` `read_community_post` `community_replies` `share_to_community` `unshare_from_community` `is_shared` `feed_coin` |
| **算力** | `credit_balance` `credit_ledger` `credit_summary` |
| **发布** | `share_link` `publish_wechat` `xhs_pack` |
| **其它** | `whoami` `list_files` `photo_url` |

**有意不做**：音频/照片的二进制上传下载。几 MB 的 base64 塞进模型上下文是灾难，App 已经干得很好。
这里只给「列出」（`list_files`）和「拿公开 URL」（`photo_url`）。

## 架构

```
functions/voicedrop/mcp.js   Pages Function 薄壳（3 行）
mcp/src/http.js              HTTP 传输：CORS、认证、JSON-RPC 收发
mcp/src/protocol.js          MCP 协议：initialize / tools/list / tools/call
mcp/src/tools.js             31 个工具的定义与实现
mcp/src/vd-client.js         VoiceDrop API 客户端 + 错误翻译
```

源码**零依赖**（要跟着 Pages Function 一起被 esbuild 打包，不能引 Node 内置模块）。
官方 `@modelcontextprotocol/sdk` 只作为 devDependency，在测试里当**真客户端**用来验协议。

### 几个不显然的约束

**为什么是 Pages Function，不是 agent worker？**
`voicedrop.cn` 是备案接入点：DNS → 腾讯云一台机器 → Caddy 反代到 Pages。Caddy 只把 `/files/*`
原样透传，**其余路径一律补 `/voicedrop` 前缀**。所以只有落在 Pages 的 `/voicedrop/mcp`，才能让
`voicedrop.cn/mcp` 直接可用，不必上那台机器改配置（README 里写着它随时可能释放）。

**为什么 agent 出站走 workers.dev？**
Pages Function 调同 zone 的 `jianshuo.dev/agent/*` 会先撞上 Pages 路由，POST 被 405 掉。
必须走 `voicedrop-agent.jianshuo.workers.dev`。`functions/files/api/[[path]].js:1431` 踩过同一个坑。

**为什么 `community_feed` 有回退？**
reco worker 没设 `SESSION_SECRET`，只认 `anon_` token——Apple session JWT 打 `/reco/feed` 会 401。
所以 401/503 时回退到 `/files/api/community/list` 的时间序列表（这也正是 App 自己的兜底策略）。
500 之类是真故障，不吞。

## 测试

```bash
cd mcp && npm install && npm test
```

89 个测试，含一关**一致性测试**：用官方 MCP SDK 的真客户端走真传输连我们手写的 server，
证明协议是真能互通，而不是自说自话。
