# VoiceDrop 口述编辑图片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户口述「把图二变成一张广告」，编辑 agent 调 paint.jianshuo.dev 出图，约 1 分钟后原地替换回笔记，计费 4.2 算力/张。

**Architecture:** 新增 agent 工具 `edit_photo`（当轮预分配 `photos/*.png` 新 key、换正文指针、调 paint 带回调）；新增 Worker 路由 `POST /agent/paint-callback`（验 token → 幂等 → 成功写广告图到 R2 + 扣 4.2 算力 / 失败写原图副本不扣）；iOS `PhotoTile` 加「制作中/失败」两态 + 404 轮询自愈。paint 零改动，写 R2 权限只在 Worker（`env.FILES`）。

**Tech Stack:** Cloudflare Worker（`agent/`，ESM，`env.FILES` R2 / `env.USAGE` D1 / `env.StatusHub` DO）、vitest（`fakeEnv`/`fakeD1`/`fakeFetch`）；SwiftUI（`voicedrop/`）。

## Global Constraints

- 计费按算力计价：`imageCostUY() = suanliToUY(4.2)` = `Math.round(4.2/23*1e6)` = **182609 微元**（≈¥0.183≈$0.025）。**仅成功扣费**，失败不扣。
- pending 文案统一「约 1 分钟完成」（设计稿写的「预计 10 秒内完成」按此改）。
- `newKey` 必须形如 `photos/<session>/<ts>.png`——`scope+newKey` = `users/<sub>/photos/….png`，才被公开 `/files/api/photo/` 端点服务（正则 `^users/[^/]+/photos/.+\.(jpe?g|png)$`）。
- 回调**验 token 在写 R2 之前**；`callback_meta` 是 Worker 自己发出、原样回来的（验身后可信），`newKey` 非攻击者可控。
- 幂等：`env.FILES.head(scope+newKey)` 已存在 → no-op（不重复写、不双扣）。
- paint 服务零改动（已支持 image_url + callback_url/callback_token/callback_meta + status done/failed）。
- 图片请求固定 `size: "1024x1024"`（1:1，1024 分辨率——方形标准档；1024 是 16 的倍数，paint/gpt-image-2-skill 直接接受）。固定价 4.2 算力/张与分辨率无关，1024 只为更快出图。
- ESM 相对 import；agent 测试 `vitest run`，`vi.mock("agents", …)` 隔离 `agents` 包；commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 账户 key（`debit`/`ensureAccount` 的 `userSub` 参数）用 `scope` 字符串，与既有 mine/edit 扣费一致。

---

## File Structure

```
agent/src/usage.js          # + IMAGE_SUANLI, imageCostUY()
agent/src/tools.js          # + makeEditedKey() (exported), + edit_photo 工具
agent/src/edit-turn.js      # TERMINAL 数组 + "edit_photo"
agent/src/index.js          # + POST /agent/paint-callback 路由
agent/test/fakes.js         # FILES fake + head()
agent/test/usage-image.test.js        # imageCostUY
agent/test/edit-photo-tool.test.js    # edit_photo 工具
agent/test/paint-callback-route.test.js # 回调路由
voicedrop/VoiceDropApp/RecordingDetailView.swift  # PhotoTile 两态+重试
agent/wrangler.jsonc        # (可选) PAINT_BASE var；secrets 用 wrangler secret put
```

---

## Task 1: 计费单价 `imageCostUY`

**Files:**
- Modify: `agent/src/usage.js`
- Test: `agent/test/usage-image.test.js`

**Interfaces:**
- Produces: `IMAGE_SUANLI` (number, 4.2)；`imageCostUY(): number`（微元，= `suanliToUY(IMAGE_SUANLI)`）。

- [ ] **Step 1: 写失败测试**

`agent/test/usage-image.test.js`：
```js
import { describe, it, expect } from "vitest";
import { imageCostUY, IMAGE_SUANLI, suanliToUY } from "../src/usage.js";

describe("image pricing", () => {
  it("IMAGE_SUANLI is 4.2", () => { expect(IMAGE_SUANLI).toBe(4.2); });
  it("imageCostUY == suanliToUY(4.2) == 182609 微元", () => {
    expect(imageCostUY()).toBe(suanliToUY(4.2));
    expect(imageCostUY()).toBe(182609);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/usage-image.test.js`
Expected: FAIL —— `imageCostUY` / `IMAGE_SUANLI` is not a function/undefined。

- [ ] **Step 3: 实现**

在 `agent/src/usage.js` 末尾（`asrCostUY` 附近）加：
```js
// 图片编辑（gpt-image-2 via paint）单价：按算力计价，避免 FX 漂移。
export const IMAGE_SUANLI = 4.2;
export function imageCostUY() { return suanliToUY(IMAGE_SUANLI); }
```
（`suanliToUY` 同文件已定义：`(s) => Math.round((s / RATE) * 1e6)`，RATE=23 → round(4.2/23*1e6)=182609。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/usage-image.test.js`
Expected: PASS（2）。

- [ ] **Step 5: commit**

```bash
cd agent && git add src/usage.js test/usage-image.test.js
git commit -m "feat(agent): 图片编辑单价 imageCostUY = 4.2 算力

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `makeEditedKey` 纯函数

**Files:**
- Modify: `agent/src/tools.js`
- Test: `agent/test/edit-photo-tool.test.js`（本任务只加 makeEditedKey 用例；Task 3 复用同文件）

**Interfaces:**
- Produces: `export function makeEditedKey(oldKey: string, nowMs: number): string` —— 从旧 key 抠出 session 段，返回 `photos/<session>/<nowMs>.png`；抠不出用 nowMs 作 session。

- [ ] **Step 1: 写失败测试**

`agent/test/edit-photo-tool.test.js`：
```js
import { describe, it, expect } from "vitest";
import { makeEditedKey } from "../src/tools.js";

describe("makeEditedKey", () => {
  it("keeps session dir, new ts, .png", () => {
    expect(makeEditedKey("photos/1719900000/1719900000.jpg", 1719999999))
      .toBe("photos/1719900000/1719999999.png");
  });
  it("falls back to nowMs session when unparseable", () => {
    expect(makeEditedKey("weird", 42)).toBe("photos/42/42.png");
  });
  it("result matches the public /photo key shape after scope prefix", () => {
    const rel = makeEditedKey("photos/abc/def.png", 7);
    expect("users/sub/" + rel).toMatch(/^users\/[^/]+\/photos\/.+\.(jpe?g|png)$/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/edit-photo-tool.test.js`
Expected: FAIL —— `makeEditedKey` is not a function。

- [ ] **Step 3: 实现**

在 `agent/src/tools.js`（`relKey` 附近）加：
```js
// 编辑结果的新 R2 相对键：保留原图的 session 目录、换新时间戳文件名、强制 .png
// （paint 默认出 png）。scope+此键必须匹配公开 /photo 端点的 photos/*.(jpg|png)。
export function makeEditedKey(oldKey, nowMs) {
  const m = /^photos\/([^/]+)\//.exec(String(oldKey || ""));
  const session = m ? m[1] : String(nowMs);
  return `photos/${session}/${nowMs}.png`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/edit-photo-tool.test.js`
Expected: PASS（3）。

- [ ] **Step 5: commit**

```bash
cd agent && git add src/tools.js test/edit-photo-tool.test.js
git commit -m "feat(agent): makeEditedKey 生成编辑结果 R2 键

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `edit_photo` 工具

**Files:**
- Modify: `agent/src/tools.js`（import + register edit_photo）
- Modify: `agent/src/edit-turn.js`（TERMINAL 加 "edit_photo"）
- Test: `agent/test/edit-photo-tool.test.js`（追加）

**Interfaces:**
- Consumes: `makeEditedKey`（Task 2）、`imageCostUY`（Task 1）、`ensureAccount`（usage_store）、`putArticleDoc`/`resolveArticles`（tools.js 内）、ctx `{env, scope, articleKey, token, origin, editId, articleIndex}`。
- Produces: 工具 `edit_photo`，input `{ key: string, prompt: string }`，成功 `{ ok:true, message }`，失败 `{ error }`。副作用：正文 `[[photo:key]]`→`[[photo:newKey]]`（putArticleDoc）+ `POST ${PAINT_BASE}/api/jobs`。
- Env 读取：`env.PAINT_BASE`（默认 `https://paint.jianshuo.dev`）、`env.PAINT_API_TOKEN`、`env.PAINT_CALLBACK_TOKEN`。

- [ ] **Step 1: 写失败测试（追加到 edit-photo-tool.test.js）**

```js
import { vi, describe, it, expect, afterEach } from "vitest";
import { runTool } from "../src/tools.js";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";

const SCOPE = "users/sub123/";
const ARTICLE_KEY = SCOPE + "articles/VoiceDrop-2026-07-02-000000.json";
const OLD = "photos/171/171.jpg";

function seedDoc() {
  return JSON.stringify({
    transcript: "t",
    articles: [{ title: "标题", body: `第一段。\n[[photo:${OLD}]]\n第二段。` }],
  });
}

async function makeCtx({ grantSuanli = 500 } = {}) {
  const env = fakeEnv({ [ARTICLE_KEY]: seedDoc() });
  env.USAGE = fakeD1(usageSql());
  // seed balance
  const now = 1;
  await env.USAGE.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, 0,0,0,now,now).run();
  await env.USAGE.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, Math.round(grantSuanli/23*1e6), Math.round(grantSuanli/23*1e6), "seed", now, null).run();
  env.PAINT_API_TOKEN = "ptok"; env.PAINT_CALLBACK_TOKEN = "cbtok"; env.PAINT_BASE = "https://paint.test";
  return { env, scope: SCOPE, articleKey: ARTICLE_KEY, token: "utok", origin: "https://vd.test", editId: "e1", articleIndex: 0 };
}

// route fetch: PUT article → capture; POST paint → capture + 202
function stubFetch({ paintStatus = 202 } = {}) {
  const calls = { put: null, paint: null };
  const fn = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes("/files/api/articles/")) { calls.put = { url: u, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u.includes("/api/jobs")) { calls.paint = { url: u, body: JSON.parse(init.body), headers: init.headers }; return { ok: paintStatus === 202, status: paintStatus, json: async () => ({ job_id: "j1" }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("edit_photo tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("swaps marker to a new .png key and fires paint with correct body", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch();
    const r = await runTool("edit_photo", { key: OLD, prompt: "make it an ad" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("约 1 分钟完成");
    // article PUT body swapped old→new marker
    const body = calls.put.body.articles[0].body;
    expect(body).not.toContain(`[[photo:${OLD}]]`);
    expect(body).toMatch(/\[\[photo:photos\/171\/\d+\.png\]\]/);
    // paint POST body
    expect(calls.paint.headers.Authorization).toBe("Bearer ptok");
    expect(calls.paint.body.prompt).toBe("make it an ad");
    expect(calls.paint.body.size).toBe("1024x1024");
    expect(calls.paint.body.image_url).toBe(`https://vd.test/files/api/photo/${SCOPE}${OLD}`);
    expect(calls.paint.body.callback_url).toBe("https://vd.test/agent/paint-callback");
    expect(calls.paint.body.callback_token).toBe("cbtok");
    expect(calls.paint.body.callback_meta.oldKey).toBe(OLD);
    expect(calls.paint.body.callback_meta.newKey).toMatch(/^photos\/171\/\d+\.png$/);
    expect(calls.paint.body.callback_meta.scope).toBe(SCOPE);
  });

  it("rejects when balance < imageCostUY (no paint call)", async () => {
    const ctx = await makeCtx({ grantSuanli: 1 }); // < 4.2
    const calls = stubFetch();
    const r = await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(r.error).toContain("算力不足");
    expect(calls.paint).toBe(null);
  });

  it("errors when key not in body", async () => {
    const ctx = await makeCtx();
    stubFetch();
    const r = await runTool("edit_photo", { key: "photos/zzz/zzz.jpg", prompt: "x" }, ctx);
    expect(r.error).toBe("找不到这张图");
  });

  it("reverts marker when paint submit fails (non-202)", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch({ paintStatus: 500 });
    const r = await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(r.error).toBe("图片服务提交失败");
    // last article PUT reverts to old marker (revert write happened)
    expect(calls.put.body.articles[0].body).toContain(`[[photo:${OLD}]]`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/edit-photo-tool.test.js`
Expected: FAIL —— `runTool("edit_photo", …)` 返回 `{ error: "unknown_tool" }`。

- [ ] **Step 3: 实现 —— import + register**

在 `agent/src/tools.js` 顶部 import 区加：
```js
import { imageCostUY } from "./usage.js";
import { ensureAccount } from "./usage_store.js";
```
在文件末尾（`share_to_community` 之后）加：
```js
register(
  {
    name: "edit_photo",
    description:
      "把当前文章里某张图按指令重画/编辑（如变成广告、换背景、改风格）。参数 key 用该图 [[photo:KEY]] 里的 KEY（从当前正文图M那行读出）；prompt 是你把用户口述蒸馏成的完整图像编辑指令。异步：提交后约 1 分钟自动替换，本轮先告诉用户在处理，不要重复调用。",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "要编辑的图片的 [[photo:KEY]] 里的 KEY，原样照抄，一个字都不要改。" },
        prompt: { type: "string", description: "编辑指令蒸馏成的完整 prompt，例如：把这张产品照做成干净的电商广告主图，突出主体、简洁背景、留白舒适。" },
      },
      required: ["key", "prompt"],
      additionalProperties: false,
    },
  },
  async ({ key, prompt }, ctx) => {
    const { env, scope, articleKey, articleIndex, origin, editId } = ctx;
    if (!key || !prompt) return { error: "missing_key_or_prompt" };

    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);
    if (bal < imageCostUY()) return { error: "算力不足，生成一张图 4.2 算力，请充值" };

    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc);
    if (!articles.length) return { error: "no_article" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;

    const marker = `[[photo:${key}]]`;
    if (!String(articles[idx].body || "").includes(marker)) return { error: "找不到这张图" };

    const newKey = makeEditedKey(key, now);
    const newMarker = `[[photo:${newKey}]]`;
    const swap = (b) => String(b).split(marker).join(newMarker);
    doc.articles = articles.map((a, i) => {
      const next = { title: String(a.title || "(无题)"), body: i === idx ? swap(a.body) : String(a.body || "") };
      if (a.wechatMediaId) next.wechatMediaId = a.wechatMediaId;
      return next;
    });
    delete doc.title; delete doc.body;
    const werr = await putArticleDoc(doc, ctx);
    if (werr) return werr;

    const paintBase = env.PAINT_BASE || "https://paint.jianshuo.dev";
    let resp = null;
    try {
      resp = await globalThis.fetch(`${paintBase}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          size: "1024x1024",
          image_url: `${origin}/files/api/photo/${scope}${key}`,
          callback_url: `${origin}/agent/paint-callback`,
          callback_token: env.PAINT_CALLBACK_TOKEN,
          callback_meta: { scope, oldKey: key, newKey, articleKey, editId: editId || null },
        }),
      });
    } catch { resp = null; }

    if (!resp || resp.status !== 202) {
      // 回退指针：把 newKey 换回 oldKey，保持文档与"没有在跑的任务"一致
      const revert = resolveArticles(doc).map((a, i) => {
        const next = { title: a.title, body: i === idx ? String(a.body).split(newMarker).join(marker) : a.body };
        if (a.wechatMediaId) next.wechatMediaId = a.wechatMediaId;
        return next;
      });
      await putArticleDoc({ ...doc, articles: revert }, ctx);
      return { error: "图片服务提交失败" };
    }
    return { ok: true, message: "🎨 正在把图片改成…，约 1 分钟完成" };
  }
);
```

- [ ] **Step 4: 实现 —— edit-turn TERMINAL**

`agent/src/edit-turn.js` 第 11 行，把 `edit_photo` 加进 TERMINAL（口述编辑图片也是"动了"）：
```js
const TERMINAL = ["edit_current_article", "write_article", "write_style", "publish_wechat", "share_to_community", "edit_photo"];
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd agent && npx vitest run test/edit-photo-tool.test.js`
Expected: PASS（makeEditedKey 3 + edit_photo 4）。

- [ ] **Step 6: 跑全量确认无回归**

Run: `cd agent && npx vitest run`
Expected: 全绿（含 edit-turn.test.js —— TERMINAL 多一项不影响既有断言）。

- [ ] **Step 7: commit**

```bash
cd agent && git add src/tools.js src/edit-turn.js test/edit-photo-tool.test.js
git commit -m "feat(agent): edit_photo 工具——口述编辑图片调 paint、当轮换指针

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `POST /agent/paint-callback` 路由

**Files:**
- Modify: `agent/src/index.js`（import + 路由）
- Modify: `agent/test/fakes.js`（FILES fake 加 `head`）
- Test: `agent/test/paint-callback-route.test.js`

**Interfaces:**
- Consumes: `imageCostUY`（usage.js）、`debit`（usage_store，index.js 已 import）、`env.FILES`/`env.USAGE`/`env.PAINT_CALLBACK_TOKEN`。
- Produces: 路由 `POST /agent/paint-callback`；body `{ job_id, status, result_url, callback_meta:{scope,oldKey,newKey} }`；成功写 `scope+newKey` + debit imageCostUY；失败写原图副本不 debit；幂等（head 命中→no-op）；无/错 token→401。

- [ ] **Step 1: fakes.js 加 head**

`agent/test/fakes.js` 的 FILES fake（`export function fakeEnv`）里，给 FILES 对象加 `head`（返回存在与否，仿 R2）。在 `get`/`put` 旁加：
```js
    head: async (k) => (store.has(k) ? { key: k, size: (store.get(k)?.length ?? 0) } : null),
```
（`store` 是 fakeEnv 内部的 Map；若变量名不同，按实际的内部存储改。确保 `put` 后 `head` 能查到、`get` 返回带 `.body`/`.text()` 的对象——沿用现有 fake 的返回形状。）

- [ ] **Step 2: 写失败测试**

`agent/test/paint-callback-route.test.js`：
```js
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import worker from "../src/index.js";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";
import { imageCostUY } from "../src/usage.js";
import { balanceUY } from "../src/usage_store.js";

const SCOPE = "users/sub123/";
const OLD = "photos/171/171.jpg";
const NEW = "photos/171/999.png";

async function env0({ withOldPhoto = true } = {}) {
  const seed = withOldPhoto ? { [SCOPE + OLD]: "OLDBYTES" } : {};
  const env = fakeEnv(seed);
  env.USAGE = fakeD1(usageSql());
  const now = 1;
  await env.USAGE.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(SCOPE,0,0,0,now,now).run();
  await env.USAGE.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, 1000000, 1000000, "seed", now, null).run();
  env.PAINT_CALLBACK_TOKEN = "cbtok";
  return env;
}
function req(body, token = "cbtok") {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  return new Request("https://vd.test/agent/paint-callback", { method: "POST", headers: h, body: JSON.stringify(body) });
}
const meta = { scope: SCOPE, oldKey: OLD, newKey: NEW };

describe("POST /agent/paint-callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("401 without token", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", callback_meta: meta }, ""), env);
    expect(res.status).toBe(401);
  });

  it("done: writes ad bytes to newKey and debits imageCostUY", async () => {
    const env = await env0();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: "ADBYTES", headers: { get: () => "image/png" } })));
    const before = await balanceUY(env.USAGE, SCOPE, 2);
    const res = await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/results/x.png", callback_meta: meta }), env);
    expect(res.status).toBe(200);
    expect(await env.FILES.head(SCOPE + NEW)).toBeTruthy();
    const after = await balanceUY(env.USAGE, SCOPE, 2);
    expect(before - after).toBe(imageCostUY());
  });

  it("failed: writes original copy, no debit", async () => {
    const env = await env0();
    const before = await balanceUY(env.USAGE, SCOPE, 2);
    const res = await worker.fetch(req({ job_id: "j1", status: "failed", callback_meta: meta }), env);
    expect(res.status).toBe(200);
    const put = await env.FILES.get(SCOPE + NEW);
    expect(await put.text()).toBe("OLDBYTES");
    expect(await balanceUY(env.USAGE, SCOPE, 2)).toBe(before); // unchanged
  });

  it("idempotent: second done callback is a no-op (no double debit)", async () => {
    const env = await env0();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: "ADBYTES", headers: { get: () => "image/png" } })));
    const b0 = await balanceUY(env.USAGE, SCOPE, 2);
    await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/x.png", callback_meta: meta }), env);
    const b1 = await balanceUY(env.USAGE, SCOPE, 2);
    await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/x.png", callback_meta: meta }), env);
    const b2 = await balanceUY(env.USAGE, SCOPE, 2);
    expect(b0 - b1).toBe(imageCostUY());
    expect(b1).toBe(b2); // no second debit
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd agent && npx vitest run test/paint-callback-route.test.js`
Expected: FAIL —— 路由不存在（404，非 401/200）。

- [ ] **Step 4: 实现路由**

`agent/src/index.js`：确认顶部已 `import { debit } from "./usage_store.js"`（现有）；加 `import { imageCostUY } from "./usage.js"`（现有 usage import 那行补上 `imageCostUY`）。在 `export default { async fetch }` 里、`/agent/notify` 路由旁加：
```js
    // ── /agent/paint-callback ── paint 出图完成回调：验 token → 幂等 → 写 R2 (+扣费) ──
    if (url.pathname === "/agent/paint-callback") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.PAINT_CALLBACK_TOKEN || tok !== env.PAINT_CALLBACK_TOKEN) return new Response("unauthorized", { status: 401 });
      const body = await request.json().catch(() => null);
      const m = body && body.callback_meta;
      if (!m || !m.scope || !m.newKey) return J({ error: "bad request" }, 400);
      const fullNew = m.scope + m.newKey;
      // 幂等：结果键已存在 → 回调重送，直接成功不重复写/扣费
      if (await env.FILES.head(fullNew)) return J({ ok: true, dedup: true });
      if (body.status === "done" && body.result_url) {
        const r = await globalThis.fetch(body.result_url);
        if (!r.ok) return J({ error: `fetch_result_${r.status}` }, 502);
        await env.FILES.put(fullNew, r.body, { httpMetadata: { contentType: r.headers.get("content-type") || "image/png" } });
        await debit(env.USAGE, m.scope, imageCostUY(), "image-edit", { jobId: body.job_id || null, newKey: m.newKey }, Date.now());
      } else {
        // 失败：写原图副本（保留原图可见），不扣费
        const o = m.oldKey ? await env.FILES.get(m.scope + m.oldKey) : null;
        if (o) await env.FILES.put(fullNew, o.body, { httpMetadata: { contentType: (o.httpMetadata && o.httpMetadata.contentType) || "image/jpeg" } });
      }
      return J({ ok: true });
    }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd agent && npx vitest run test/paint-callback-route.test.js`
Expected: PASS（4）。

- [ ] **Step 6: 跑全量**

Run: `cd agent && npx vitest run`
Expected: 全绿。

- [ ] **Step 7: commit**

```bash
cd agent && git add src/index.js test/fakes.js test/paint-callback-route.test.js
git commit -m "feat(agent): /agent/paint-callback 验签写 R2 + 成功扣费/失败留原图

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: iOS `PhotoTile` 制作中 / 失败两态 + 重试

**Files:**
- Modify: `voicedrop/VoiceDropApp/RecordingDetailView.swift`（`struct PhotoTile`，约 1021–1056 行）

**Interfaces:** 无自动化测试（SwiftUI 视图，手动验证）。行为：`photoData` 拿到→显示图；404→「制作中」金棕占位 + 每 3s 重试；超 5 分钟→「暂时无法显示 + 重试」灰占位。只改 `PhotoTile`。

- [ ] **Step 1: 用两态占位 + 重试循环替换 PhotoTile 实现**

把 `struct PhotoTile { … }` 整体替换为：
```swift
struct PhotoTile: View {
    let store: LibraryStore
    let relKey: String

    @State private var image: UIImage?
    @State private var failed = false
    @State private var reloadToken = 0
    @State private var dim = false   // 呼吸点/扫光驱动

    // 设计稿 Image Placeholder.dc.html 的暖纸/金棕/灰配色
    private let paperTop = Color(red: 0.953, green: 0.933, blue: 0.894)   // #F3EEE4
    private let paperBot = Color(red: 0.925, green: 0.894, blue: 0.839)   // #ECE4D6
    private let gold     = Color(red: 0.788, green: 0.541, blue: 0.180)   // #C98A2E
    private let goldText = Color(red: 0.541, green: 0.482, blue: 0.376)   // #8A7B60
    private let corner   = Color(red: 0.706, green: 0.663, blue: 0.561)   // #B4A98F
    private let failBg   = Color(red: 0.957, green: 0.945, blue: 0.922)   // #F4F1EB
    private let failIcon = Color(red: 0.690, green: 0.655, blue: 0.596)   // #B0A798
    private let failText = Color(red: 0.604, green: 0.569, blue: 0.514)   // #9A9183
    private let retryOra = Color(red: 0.753, green: 0.408, blue: 0.180)   // #C0682E

    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Theme.card)
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .overlay {
                if let img = image {
                    Image(uiImage: img).resizable().scaledToFill().clipShape(RoundedRectangle(cornerRadius: 12))
                } else if failed {
                    failedView
                } else {
                    makingView
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .task(id: "\(relKey)#\(reloadToken)") { await load() }
    }

    private var makingView: some View {
        LinearGradient(colors: [paperTop, paperBot], startPoint: .topLeading, endPoint: .bottomTrailing)
            .overlay {
                VStack(spacing: 12) {
                    Image(systemName: "photo").font(.system(size: 30, weight: .regular)).foregroundStyle(gold)
                    Text("正在制作中").font(.system(size: 13, weight: .semibold)).foregroundStyle(goldText)
                    HStack(spacing: 5) {
                        ForEach(0..<3) { i in
                            Circle().fill(gold).frame(width: 5, height: 5)
                                .opacity(dim ? 0.25 : 1)
                                .animation(.easeInOut(duration: 0.7).repeatForever().delay(Double(i) * 0.2), value: dim)
                        }
                    }
                    Text("约 1 分钟完成").font(.system(size: 11)).foregroundStyle(corner)
                }
            }
            .onAppear { dim = true }
    }

    private var failedView: some View {
        failBg.overlay {
            VStack(spacing: 10) {
                Image(systemName: "photo").font(.system(size: 30)).foregroundStyle(failIcon)
                Text("暂时无法显示").font(.system(size: 12)).foregroundStyle(failText)
                Button {
                    failed = false; image = nil; reloadToken += 1
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
                        Text("重试").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(retryOra)
                    .padding(.horizontal, 11).padding(.vertical, 4)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(retryOra.opacity(0.35)))
                }
            }
        }
    }

    private func load() async {
        image = nil; failed = false
        guard let scope = await store.ownerScope() else { failed = true; return }
        let deadline = Date().addingTimeInterval(300)   // 5 分钟封顶
        while !Task.isCancelled && Date() < deadline {
            if let data = await store.photoData(fullKey: scope + relKey), let ui = UIImage(data: data) {
                image = ui; return
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)  // 3s 后重试（仅在图可见且未出时）
        }
        if image == nil && !Task.isCancelled { failed = true }
    }
}
```

- [ ] **Step 2: 编译**

Run（无 xcodebuild 时至少语法自检；有则）:
```
cd voicedrop && xcodebuild -project VoiceDrop.xcodeproj -scheme VoiceDrop -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -20
```
Expected: BUILD SUCCEEDED（或在 Xcode 里编译通过）。若无构建环境，人工在 Xcode 编译。

- [ ] **Step 3: 手动冒烟（预览/模拟器）**

- 造一条正文含一个指向不存在 key 的 `[[photo:photos/x/nope.png]]` 的笔记 → PhotoTile 显示金棕「正在制作中」+ 呼吸点 +「约 1 分钟完成」。
- 往该 key 写入图片（或等真实回调）→ 3s 内自动切换显示图。
- 正常已存在的图 → 秒显示，不进占位。
（此步在真机端到端 Task 6 一并验证。）

- [ ] **Step 4: commit**

```bash
cd voicedrop && git add VoiceDropApp/RecordingDetailView.swift
git commit -m "feat(voicedrop): PhotoTile 制作中/失败两态 + 404 轮询自愈

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6（配置 + 人工）: Worker secrets + 部署 + 真机端到端

> 需真操作 Cloudflare + 真机 + 真 Codex。执行者做完贴回结果。

- [ ] **Step 1: Worker secrets**（`cd agent`）
  - `wrangler secret put PAINT_API_TOKEN` → 值 = paint VPS `/opt/paint/.env` 里的 `API_TOKEN`（`ssh root@66.42.45.128 'grep ^API_TOKEN= /opt/paint/.env | cut -d= -f2'`）。
  - `wrangler secret put PAINT_CALLBACK_TOKEN` → 新生成 `openssl rand -hex 32`（Worker 自定，回调里校验）。
  - （可选 HMAC 校验若实现）`wrangler secret put PAINT_SIGNING_SECRET` → = paint 的 `CALLBACK_SIGNING_SECRET`。
  - （可选）`PAINT_BASE` 写进 `wrangler.jsonc` 的 `vars`，默认 `https://paint.jianshuo.dev`。
- [ ] **Step 2: 部署 Worker**：`cd agent && wrangler deploy`。
- [ ] **Step 3: 连通性**：`curl -s -o /dev/null -w "%{http_code}" -X POST https://<worker-host>/agent/paint-callback`（无 token 应 401）。
- [ ] **Step 4: 真机端到端**：App 里打开一条带图笔记，口述「把图二变成一张广告」→ 看到「🎨 正在把图片改成…，约 1 分钟完成」→ PhotoTile 显示「制作中」→ 约 1 分钟后原地替换成广告图 → 查算力余额 -4.2。
- [ ] **Step 5: 失败路径抽验**（可选）：临时让 paint 出错（如超大 size）确认回调写原图副本、余额不变。
- [ ] **Step 6: 记忆**：更新 [[paint-jianshuo-dev]] 记忆补一句"VoiceDrop 口述编辑图片已接入（edit_photo + /agent/paint-callback）"。

---

## Self-Review

**1. Spec coverage**（对照 2026-07-02 spec）：
- §3.A edit_photo → Task 2（makeEditedKey）+ Task 3 ✅（预检/换指针/调 paint/回退全覆盖）
- §3.B /agent/paint-callback → Task 4 ✅（验 token/幂等/done 写+扣/failed 写原图）
- §3.C 计费 → Task 1 + Task 3 预检 + Task 4 扣费 ✅
- §3.D iOS 两态 → Task 5 ✅（制作中金棕+呼吸点+「约1分钟完成」/失败灰+重试/404 轮询）
- §3.E 共享密钥 → Task 6 ✅
- §3.F paint 零改动 ✅（无任务动 paint）
- §4 key 命名/pending → Task 2（photos/*.png）+ Task 5（404=pending）✅
- §5 失败=原图副本 → Task 4 ✅
- §6 安全（验身先于写、幂等、无任意 key 写）→ Task 4 ✅
- §7 测试 → Task 1/3/4 单元+路由，Task 5/6 手动 ✅

**2. Placeholder scan**：无 TODO/TBD；每个代码步含完整代码。fakes.js head 的「按实际内部存储变量名改」是对既有 fake 的适配说明，非占位（实现者读 fakes.js 即知 Map 变量名）。

**3. Type consistency**：`makeEditedKey(oldKey,nowMs)`、`imageCostUY()`、`debit(db,scope,uy,reason,detail,now)`、`ensureAccount(db,scope,now)→balance`、`putArticleDoc(doc,ctx)`、callback_meta `{scope,oldKey,newKey}`、tool input `{key,prompt}` 在定义处与调用处一致 ✅。scope 作为账户 key 与既有 mine/edit 一致 ✅。
