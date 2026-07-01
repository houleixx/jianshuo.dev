# VoiceDrop 口述编辑图片 —— 设计 spec

- 日期：2026-07-02
- 状态：设计讨论完成，待用户确认 → 实现计划
- 依赖：[[paint.jianshuo.dev]]（已上线，Codex 订阅版 gpt-image-2 图片服务，带 webhook 回调）
- 涉及仓库：`~/code/jianshuo.dev/agent/`（VoiceDrop Cloudflare Worker 后端）+ `~/code/voicedrop/`（iOS App）
- 设计稿：claude.ai/design 项目 `834ad7a9-…` 的 `Image Placeholder.dc.html`（图片占位视觉）

## 1. 目标

用户对着一条带图的笔记口述「把图二变成一张广告」，VoiceDrop 的编辑 agent 把它蒸馏成图像编辑 prompt，调用 paint.jianshuo.dev 出图，几分钟后把新图**原地替换**回笔记里图二的位置。计费每张 **0.05 USD**（≈8.4 算力）。

### 非目标（v1 不做）
- 网页版看文章（jianshuo.dev/voicedrop/articles）不渲染 `[[photo:]]` 图，本功能只在 iOS App 内成立。
- 失败态「重试」按钮只重新**加载**图片（应对回调迟到），不重新触发一次新的编辑任务（v2）。
- 可见的「编辑中」不做成文档级状态字段——用「新 key 暂时 404」这一事实驱动占位（见 §5）。

## 2. 架构与端到端流程

```
用户口述「把图二变成广告」
   │  (一次 voice-edit turn，秒回)
   ▼
edit-turn → 编辑 agent(Claude) 看到带号正文（图2 = [[photo:oldKey]]）
   │  agent 蒸馏 prompt，调用新工具 edit_photo({ key: oldKey, prompt })
   ▼
edit_photo 工具处理器（agent/src/tools.js，同步、在 turn 内完成）：
   1. 预检算力余额 ≥ imageCostUY()，不够→拒绝
   2. 生成 newKey（本次编辑结果的目标 R2 相对键，唯一）
   3. 把当前文章正文里 [[photo:oldKey]] → [[photo:newKey]]（走既有 putArticleDoc 写回，当轮定稿）
   4. POST paint.jianshuo.dev/api/jobs：
        image_url = oldKey 的公开图片 URL（files API /photo/<scope+oldKey>）
        prompt = 蒸馏后的编辑 prompt
        callback_url = https://<worker>/agent/paint-callback
        callback_token = <共享密钥>
        callback_meta = { scope, oldKey, newKey, articleKey, editId, jobLabel }
   5. 返回 agent：「🎨 正在把图二改成广告，约 10 秒后自动替换」（pending 文案）
   ▼ (turn 结束，文章已指向 newKey；newKey 在 R2 里还不存在 → 404)
paint 出图（Codex）……几十秒~几分钟
   ▼
paint 回调 → POST /agent/paint-callback（agent/src/index.js 新路由）：
   1. 验 callback_token（+ 可选 X-Paint-Signature HMAC）→ 不过就 401
   2. 幂等：env.FILES.head(scope+newKey) 已存在 → 200 no-op（回调重送不重复写/扣费）
   3. status=done：fetch(result_url) → env.FILES.put(scope+newKey, 广告图字节) → debit 0.05USD
      status=failed：env.FILES.put(scope+newKey, 原图字节副本)（保留原图，不扣费）
   ▼
iOS PhotoTile（.task 轮询）：newKey 从 404 → 有字节 → 自动显示新图
```

关键设计点：
- **写 R2 的权限在 Worker**（`env.FILES` 绑定 `jianshuo-dev-files`，现已读写）。**paint 零 R2 权限、零改动**——它只把结果放在公开 result_url + 回调。
- **newKey 当轮就写进文章**（用户的洞见）：文章一次写定，回调不再改文档，绕开「App 怎么知道重新拉文档」。
- **newKey 恰好写一次**：成功=广告图、失败=原图副本 → 缓存干净（同一 URL 从不被覆盖），也永不留裂图。
- **图二解析免费**：`edit-turn.js` 已用 `inlineNumberedBody` 给正文标「图M」且保留 `[[photo:key]]`，模型直接读出图二的 key 传给 `edit_photo`。

## 3. 组件

### A. Agent 工具 `edit_photo`（`agent/src/tools.js`）
仿现有工具（`register(def, handler)`）新增：
- 定义：`{ name: "edit_photo", description: "把当前文章里某张图（用它的 [[photo:key]] 里的 key）交给图片服务按指令重画/编辑（如变成广告、换背景）。异步：提交后几十秒自动替换，本轮先告诉用户在处理。", input_schema: { key: string(必填), prompt: string(必填，编辑指令蒸馏后的完整英文/中文 prompt) } }`
- 处理器（ctx 提供 env/scope/articleKey/token/origin/editId/articleIndex）：
  1. `ensureAccount` + 余额预检 `balance_uy >= imageCostUY()`；不足 → `{ error: "算力不足，生成一张图约 8.4 算力，请充值" }`。
  2. 读当前文章 doc；确认 `key` 确实出现在目标文章正文的某个 `[[photo:key]]` 里（防乱传）；否则 `{ error: "找不到这张图" }`。
  3. 生成 `newKey`（相对键，唯一；沿用照片键风格 `photos/<sessionTs>/<newTs>.png`，`newTs` 用请求时刻）。
  4. 正文替换 `[[photo:oldKey]]`→`[[photo:newKey]]`，`putArticleDoc` 写回（复用既有写路径，stamp editId）。
  5. `fetch(PAINT_BASE + "/api/jobs", { Authorization: Bearer PAINT_API_TOKEN, body: {...见 §2...} })`；失败（非 202）→ 回退正文 newKey→oldKey 并 `{ error: "图片服务提交失败" }`。
  6. 成功 → `{ ok: true, message: "🎨 正在把图片改成…，约 10 秒后自动替换" }`（不是 TERMINAL 工具，agent 可继续/结束）。
- 配置读取：`PAINT_BASE`（默认 `https://paint.jianshuo.dev`）、`PAINT_API_TOKEN`、`PAINT_CALLBACK_TOKEN`、`PAINT_SIGNING_SECRET` 从 `env`（wrangler secret）。

### B. Worker 回调路由 `POST /agent/paint-callback`（`agent/src/index.js`）
在 `export default { fetch }` 里、现有 `/agent/*` 路由旁新增：
1. 只收 POST；读 body + headers。
2. **验身**：`Authorization: Bearer` == `env.PAINT_CALLBACK_TOKEN`（+ 若带 `X-Paint-Signature` 则校 HMAC(body, env.PAINT_SIGNING_SECRET)）。不过 → 401。绝不在验身前写 R2。
3. 解 `callback_meta`（Worker 自己发出、验身后可信）：`{ scope, oldKey, newKey, articleKey, editId }`。
4. **幂等**：`await env.FILES.head(scope + newKey)` 已存在 → `J({ ok: true, dedup: true })`（不写、不扣费）。
5. `status === "done"`：`const r = await fetch(result_url)` → `env.FILES.put(scope + newKey, r.body, { httpMetadata: { contentType: r.headers.get("content-type") || "image/png" } })` → `debit(env.USAGE, scope, imageCostUY(), "image-edit", { jobId, newKey, editId }, Date.now())`。
6. `status === "failed"`：`const o = await env.FILES.get(scope + oldKey)`；有 → `env.FILES.put(scope + newKey, o.body, { httpMetadata })`（原图副本，不扣费）；无 → 记日志跳过。
7. 返回 `J({ ok: true })`。
8. （可选）通过既有 StatusHub / notify 给 App 推一条「图改好了 / 没改成」的提示——v1 可省，PhotoTile 轮询已能自愈。

### C. 计费（`agent/src/usage.js` + 上面 A/B）
- usage.js 新增：`export const IMAGE_USD = 0.05;` 和 `export function imageCostUY() { return Math.ceil(IMAGE_USD * FX * 1e6); }`（= 365000 微元 ≈ 8.4 算力）。
- 预检在 A.1（提交前，余额不足直接拒绝，不浪费 paint 调用）。
- 扣费在 B.5（**仅成功**），label `"image-edit"`，meta 带 jobId/newKey/editId。失败不扣。
- 幂等（B.4）保证回调重送不双扣。

### D. iOS 占位两态（`voicedrop/VoiceDropApp/RecordingDetailView.swift` 的 `PhotoTile`）
把现有「加载不到 → 一直转 `ProgressView()`」升级为设计稿 `Image Placeholder.dc.html` 的两态 + 重试轮询：
- **制作中（金棕）**：暖纸渐变底 `#F3EEE4→#ECE4D6`、一道扫光（横扫高光，~2.8s 循环）、轻浮的相机图标（`#C98A2E`）、文「正在制作中」（`#8A7B60`）、三个交错呼吸点（`#C98A2E`）。方形缩略尺寸即可（PhotoTile 是 1:1）。
- **确认失败（灰）**：灰底 `#F4F1EB`、灰图标 `#B0A798`、文「暂时无法显示」（`#9A9183`）、「重试」按钮（`#C0682E` 描边，点了重跑 `.task`）。
- **加载逻辑**：`.task(id: relKey)` 改为有界重试循环——`photoData` 拿到 → 显示；拿不到（404）→ 显示「制作中」，每 3s 重试；超过 5 分钟仍无 → 切「确认失败」。SwiftUI `.task` 生命周期天然收口（图可见且未出才轮询，出图/划走即停）。动效用 SwiftUI 原生（`withAnimation`/`.repeatForever` 或 TimelineView）复刻扫光/浮动/呼吸点，克制即可。
- 只改 `PhotoTile` 一个 view，其余不动。已有的正常照片秒加载、不进「制作中」。

### E. 配置：共享密钥
- paint 侧：`/opt/paint/.env` 已有 `CALLBACK_SIGNING_SECRET`（HMAC 用）。新增/沿用一个 `callback_token` 由**调用方**（Worker）在每次请求里传 `callback_token` 字段，paint 原样回作 `Authorization: Bearer`——所以 token 是 Worker 定的，不用改 paint。
- Worker 侧 wrangler secret：`PAINT_API_TOKEN`（= paint 的 `/opt/paint/.env` 里 `API_TOKEN`）、`PAINT_CALLBACK_TOKEN`（Worker 自定，随请求下发、回调里校验）、`PAINT_SIGNING_SECRET`（= paint 的 `CALLBACK_SIGNING_SECRET`，用于可选 HMAC 校验）、`PAINT_BASE`（可选，默认 https://paint.jianshuo.dev）。

### F. paint 服务
**零改动**。它已支持 `image_url` + `callback_url`/`callback_token`/`callback_meta` + HMAC 签名 + status done/failed 回调。

## 4. key 命名与 pending 表达
- `newKey` 相对键唯一（`photos/<sessionTs>/<reqTs>.png`）。文章当轮就指向它。
- **无文档级 pending 字段**：新 key 在 R2 里暂时 404 就是 pending 信号；PhotoTile 对「加载不到的图」显示制作中并轮询。普通已存在的图秒加载、不受影响。误伤面：极少见的「已被删除但仍被引用的图」会先显示制作中→5 分钟后失败，可接受。

## 5. 失败处理
- paint status=failed → 回调写 `newKey = 原图字节副本` → 用户看到原图（等于"没改成、保留原图"），不扣费，不留裂图，不改文档。
- 回调彻底没来（paint/网络全挂）→ newKey 一直 404 → PhotoTile 5 分钟后切「确认失败 + 重试」；重试重新加载（应对迟到回调）。
- edit_photo 提交阶段 paint 非 202 → 工具当场回退正文指针（newKey→oldKey）+ 报错，不计费。

## 6. 安全
- 回调**验身在写 R2 之前**（callback_token +可选 HMAC）——否则任何人都能让 Worker 往 R2 乱写。
- `newKey` 来自 Worker 自己发出、验身后原样回来的 `callback_meta`，非攻击者可控 → 无「任意 key 写入」。
- 幂等（R2 head）防重复写 + 双扣费。
- paint 无 R2 权限（blast radius 收敛在 Worker）。
- 余额预检防「无余额刷图」；成功才扣防「失败也扣」。

## 7. 测试
- **usage.js**：`imageCostUY()` == 365000（0.05×7.3×1e6 ceil）。
- **edit_photo（单元/路由）**：余额不足→拒绝不发 paint；key 不在正文→报错；正常→正文 oldKey→newKey 被替换 + 用打桩 fetch 断言 POST body（image_url/prompt/callback_*）正确 + 返回 pending 文案；paint 非 202→回退指针。
- **/agent/paint-callback（路由）**：无/错 token→401；done→FILES.put(newKey) 被调 + debit 一次；failed→写原图副本、不 debit；重复回调（head 命中）→ no-op 不双写不双扣。用打桩 env.FILES + env.USAGE。
- **iOS PhotoTile**：手动/预览——制作中态渲染、404 轮询到出图自动切换、5 分钟切失败态、重试重新加载。
- **端到端（手动，真机+真 Codex）**：一条带图笔记口述「把图X变成广告」→ 看到 pending → 几十秒后原地替换 → 算力余额 -8.4。

## 8. 后续（不在 v1）
- 失败态「重试」重新触发一次编辑任务（需 App→agent 端点带 oldKey+prompt）。
- 网页版文章渲染 `[[photo:]]` 图 + 占位。
- 回调经 StatusHub 实时推送「图好了」而非仅靠 PhotoTile 轮询。
- 多图批量编辑、编辑历史/撤销 UI。
