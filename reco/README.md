# voicedrop-reco

VD社区的推荐排序 sidecar。**可随时拔掉**:整个 down 掉也不影响 VoiceDrop —— app 会回退到核心
`community/list` 的时间倒序。

## 它是什么
- 独立 Cloudflare Worker,路由 `jianshuo.dev/reco/*`。
- 自带一张 D1 表 `engagement`,记录 view/finish/like 三个互动信号(每用户去重)。
- 算一个「互动加权 × 年龄衰减」的全局顺序(千人一面)。
- **不碰 R2、不调用核心、无 Claude。** 唯一与核心共享的是 `SESSION_SECRET` 的值(独立验 token)。

## 路由
- `POST /reco/engage/<shareId>` body `{action:"view"|"finish"|"like", on?:bool}` → `{ok}`(like 另带 `{liked}`)。
- `POST /reco/rank` body `{posts:[{shareId,firstSharedAt,author,replyCount}]}` → `{order:[shareId...], liked:[shareId...]}`。

两者都要任意有效 token(anon 也行);失败 app 都会回退,不影响 feed。

## 数据模型(D1 `voicedrop-reco`)
`engagement(share_id, user_sub, action, created_at)`,PK=`(share_id,user_sub,action)` → 天然去重。

## 排序
`score = (1 + view*1 + finish*4 + like*3 + reply*5) / (ageHours + 2)^1.5`,再做作者打散(同作者每多出现一次分 ×0.5)。权重见 `src/ranking.js` 的 `W`,可调。

## 开发 / 部署
- 测试:`npm test`(纯函数 + fake D1,不连真 D1)。
- 部署:`npx wrangler deploy`。
- 改表:加 `migrations/000N_*.sql`,`npx wrangler d1 execute voicedrop-reco --remote --file=...`。
- Secret:`npx wrangler secret put SESSION_SECRET`(与核心 Pages 项目同值)。

## 模块
- `src/ranking.js` — 纯函数 `postScore` / `rankPosts`(无 I/O,可单测)。
- `src/auth.js` — `resolveScope(token, secret)`,从核心逐字复刻的 token 验证(独立,不 import 核心)。
- `src/store.js` — D1 访问 `recordEngagement` / `countsFor` / `likedBy`。
- `src/index.js` — Worker fetch handler,路由 + 鉴权 + `env.DB` 缺失时的降级。
