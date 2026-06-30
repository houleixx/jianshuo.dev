# 默认文风懒种子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户第一次用到文风时（读设置页 GET /style 或首次挖文），把代码里隐形的默认「王建硕风格」幂等地物化成他自己拥有的、可见可改可回退的 `v1`。

**Architecture:** 在共享模块 `functions/lib/style-store.js` 新增 canonical `DEFAULT_STYLE` 文本 + 幂等 `ensureStyleSeeded()` + 判定器 `isDefaultSeed()`；`agent/src/prompts/mine.js` 的 `MINE_DEFAULT_STYLE` 改为从这里 re-export（字节一致）；GET /style 和 miner 主挖文路径各接一行 `ensureStyleSeeded`。

**Tech Stack:** Cloudflare Workers / Pages Functions（ESM）、R2（`env.FILES`）、Vitest（`agent/` 下 `npm test` = `vitest run`）。

## Global Constraints

- **单一真源**：默认风格文本只存一份，在 `functions/lib/style-store.js` 的 `DEFAULT_STYLE`；`mine.js` 仅 re-export，**字节完全一致**（下游 `buildMinePrompt`/eval 零改动）。
- **幂等**：`ensureStyleSeeded` 第二次调用绝不产生 `v2`。
- **不覆盖遗留用户**：遗留 `CLAUDE.md` 有非空 `文风` 时**不种**，返回 `null`，调用方走原有 legacy 读取路径。
- **种子来源标记**：种下的 `v1` 用 `source: "default"`（与现有 `app`/`agent`/`mine` 并列），schema 不变。
- **只在两个入口种**：`GET /style`（读当前文风）和 miner 主挖文路径。`GET /style/history`、`PUT`、`PATCH /style/head`、`tools.js` 一律不种。
- **增量字段**：GET 回传的 `default` 字段是增量的，老客户端只解码 `style` 会忽略它。
- 测试运行：`cd agent && npx vitest run test/<file>`；全量 `cd agent && npm test`。

---

### Task 1: `DEFAULT_STYLE` 搬入 style-store.js，mine.js 改 re-export

把默认风格文本从 agent 侧的 `mine.js` 搬到共享模块作为 canonical 单一真源，`mine.js` 改为 re-export，保证字节一致、下游零改动。

**Files:**
- Modify: `functions/lib/style-store.js`（在 `STYLE_MAX_VERSIONS` 常量之后新增 `DEFAULT_STYLE`）
- Modify: `agent/src/prompts/mine.js:29-35`（删字面定义，改为 import + re-export）
- Test: `agent/test/style-store.test.js`（新增 1 个 describe 块）
- 回归守卫（不改）：`agent/test/prompt-extraction.test.js`、`agent/test/build-mine-prompt.test.js`

**Interfaces:**
- Produces: `export const DEFAULT_STYLE: string`（from `functions/lib/style-store.js`）——后续 Task 2/3 依赖；`agent/src/prompts/mine.js` 继续 `export const MINE_DEFAULT_STYLE`（= `DEFAULT_STYLE`），`miner.js:24` 的 `MINE_DEFAULT_STYLE as DEFAULT_STYLE` import 不变。

- [ ] **Step 1: 写失败测试**

在 `agent/test/style-store.test.js` 顶部 import 块加入 `DEFAULT_STYLE`：

```js
import {
  readStyleDoc, resolveStyle, parseStyleMarkdown, readStyleText,
  writeStyleDoc, setStyleHead, STYLE_MAX_VERSIONS,
  readProfileName, mergeProfile,
  styleLabel, styleComment, prependStyleComment,
  DEFAULT_STYLE,
} from "../../functions/lib/style-store.js";
```

并在文件末尾追加：

```js
describe("DEFAULT_STYLE — canonical 默认王建硕风格（mine.js re-export 自此）", () => {
  it("含王建硕语气 DNA 标记", () => {
    expect(DEFAULT_STYLE).toContain("胸有成竹");
    expect(DEFAULT_STYLE).toContain("绝不用「笔者」");
  });
  it("mine.js 的 MINE_DEFAULT_STYLE 与之字节一致", async () => {
    const { MINE_DEFAULT_STYLE } = await import("../src/prompts/mine.js");
    expect(MINE_DEFAULT_STYLE).toBe(DEFAULT_STYLE);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd agent && npx vitest run test/style-store.test.js`
Expected: FAIL —— `DEFAULT_STYLE` 未从 style-store.js 导出（`undefined`，`toContain` 报错）。

- [ ] **Step 3: 在 style-store.js 新增 `DEFAULT_STYLE`**

在 `functions/lib/style-store.js` 的 `export const STYLE_MAX_VERSIONS = 10;`（:21）之后插入（文本逐字符照搬自 `mine.js:29-35`）：

```js
// The default 王建硕 writing style — canonical single source. Seeded as a user's
// own v1 by ensureStyleSeeded() on first use, and re-exported by
// agent/src/prompts/mine.js as MINE_DEFAULT_STYLE (the generation-time fallback),
// so the seed text and the fallback text can never drift.
export const DEFAULT_STYLE = `胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
细节能列就用表格 / 列表，不在叙述句里堆细节。
保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。`;
```

- [ ] **Step 4: `mine.js` 改为 import + re-export**

把 `agent/src/prompts/mine.js:29-35` 的整段 `export const MINE_DEFAULT_STYLE = \`...\`;` 替换为：

```js
// 默认王建硕风格的 canonical 文本住在共享的 style-store.js（既是种子又是生成回退），
// 这里 re-export 保持 mine.js 的对外接口不变、字节一致。
import { DEFAULT_STYLE } from "../../../functions/lib/style-store.js";
export const MINE_DEFAULT_STYLE = DEFAULT_STYLE;
```

> 注意相对路径是 `../../../`（`prompts/` → `src/` → `agent/` → repo 根 → `functions/lib/`）。其余 `export const`（`PHOTO_INSTR`/`MINE_SYSTEM`/`MINE_SYSTEM_FORCE`/schema）一行不动。

- [ ] **Step 5: 运行确认通过（含回归）**

Run: `cd agent && npx vitest run test/style-store.test.js test/prompt-extraction.test.js test/build-mine-prompt.test.js`
Expected: PASS —— 新 describe 通过；`prompt-extraction`（断言 `MINE_DEFAULT_STYLE` 含「胸有成竹」「绝不用「笔者」」）与 `build-mine-prompt`（断言 system 含「胸有成竹」）作为字节一致回归守卫照常通过。

- [ ] **Step 6: 提交**

```bash
git add functions/lib/style-store.js agent/src/prompts/mine.js agent/test/style-store.test.js
git commit -m "refactor(style): DEFAULT_STYLE 移入 style-store 单一真源，mine.js 改 re-export"
```

---

### Task 2: `ensureStyleSeeded` + `isDefaultSeed`

幂等的懒种子核心逻辑与判定器，全部单元测试覆盖。

**Files:**
- Modify: `functions/lib/style-store.js`（紧跟 Task 1 的 `DEFAULT_STYLE` 之后新增两个导出）
- Test: `agent/test/style-store.test.js`（新增 1 个 describe 块，5 例）

**Interfaces:**
- Consumes: `DEFAULT_STYLE`（Task 1）、模块内既有的 `readStyleDoc`、`writeStyleDoc`、`parseStyleMarkdown`。
- Produces:
  - `export async function ensureStyleSeeded(env, styleKey, legacyKey): Promise<doc|null>` —— 已有 doc → 原样返回；遗留 CLAUDE.md 有非空文风 → 返回 `null`（不种）；否则写 `source:"default"` 的 `v1` 并返回新 doc。
  - `export function isDefaultSeed(doc): boolean` —— doc 恰好 1 个版本、`v===1`、`source==="default"` → `true`。

- [ ] **Step 1: 写失败测试**

在 `agent/test/style-store.test.js` 的 import 块再加 `ensureStyleSeeded, isDefaultSeed`：

```js
  DEFAULT_STYLE, ensureStyleSeeded, isDefaultSeed,
```

文件末尾追加：

```js
describe("ensureStyleSeeded — 懒种子默认文风为 v1", () => {
  it("无 CLAUDE.json / 无 legacy → 种 v1（source=default），isDefaultSeed=true", async () => {
    const env = fakeEnv({});
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ v: 1, source: "default", style: DEFAULT_STYLE });
    expect(isDefaultSeed(doc)).toBe(true);
    // 已落库
    expect(resolveStyle(JSON.parse(env.FILES._store.get(KEY)))).toBe(DEFAULT_STYLE);
  });

  it("幂等：再调一次不产生 v2", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
  });

  it("已有 CLAUDE.json → 原样返回，不被默认覆盖", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "我自己的文风", "app");   // head 1, source app
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions[0]).toMatchObject({ source: "app", style: "我自己的文风" });
    expect(isDefaultSeed(doc)).toBe(false);                 // source 非 default
  });

  it("遗留 CLAUDE.md 有文风 → 不种，返回 null，CLAUDE.json 仍不存在", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的名字\n王建硕\n\n# 我的文风\n老用户的文风" });
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc).toBeNull();
    expect(env.FILES._store.has(KEY)).toBe(false);
  });

  it("isDefaultSeed：种 v1 后编辑成 v2 → false", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);              // v1 default
    const doc = await writeStyleDoc(env, KEY, "改成我的", "app"); // v2
    expect(doc.head).toBe(2);
    expect(isDefaultSeed(doc)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd agent && npx vitest run test/style-store.test.js`
Expected: FAIL —— `ensureStyleSeeded is not a function` / `isDefaultSeed is not a function`。

- [ ] **Step 3: 实现两个导出**

在 `functions/lib/style-store.js` 的 `DEFAULT_STYLE` 之后插入：

```js
// Lazy-seed the default 王建硕 style as the user's own v1 the first time anyone
// touches their style (settings read or first mine). Idempotent: returns the
// existing doc untouched if a CLAUDE.json is already there. Returns null WITHOUT
// seeding when a legacy CLAUDE.md already holds 文风 (don't clobber an old user —
// callers fall back to their existing legacy-read path). Otherwise writes v1
// (source "default") and returns the new doc.
export async function ensureStyleSeeded(env, styleKey, legacyKey) {
  const doc = await readStyleDoc(env, styleKey);
  if (doc) return doc;
  if (legacyKey) {
    const legacy = await env.FILES.get(legacyKey);
    if (legacy && parseStyleMarkdown(await legacy.text()).trim()) return null;
  }
  return writeStyleDoc(env, styleKey, DEFAULT_STYLE, "default");
}

// True iff the doc is still the un-edited default seed: exactly one version, v1,
// source "default". Once the user edits (v2) or restyle/mine appends, it's false.
// SINGLE SOURCE for the GET /style `default` flag and any future re-seed migration.
export function isDefaultSeed(doc) {
  return !!doc && doc.head === 1
    && Array.isArray(doc.versions) && doc.versions.length === 1
    && doc.versions[0].v === 1 && doc.versions[0].source === "default";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd agent && npx vitest run test/style-store.test.js`
Expected: PASS —— 5 例全过。

- [ ] **Step 5: 提交**

```bash
git add functions/lib/style-store.js agent/test/style-store.test.js
git commit -m "feat(style): ensureStyleSeeded 幂等懒种子 + isDefaultSeed 判定器"
```

---

### Task 3: 接线 `GET /style`

设置页第一次打开时种 v1 并回传可编辑基线，带 `default` 标记。

**Files:**
- Modify: `functions/files/api/[[path]].js:23`（import 加 `ensureStyleSeeded, isDefaultSeed`）
- Modify: `functions/files/api/[[path]].js:722-732`（GET 主分支）
- Test: `agent/test/style-api.test.js`（改 1 个既有用例 + 加 1 例）

**Interfaces:**
- Consumes: `ensureStyleSeeded`、`isDefaultSeed`（Task 2）。
- Produces: `GET /style` 在用户无文风时返回 `{ style: DEFAULT_STYLE, name:'', head:1, default:true, … }`；已有用户照常并附 `default:false`。

- [ ] **Step 1: 改既有测试 + 写新失败测试**

`agent/test/style-api.test.js` 里把现有用例「404s when neither CLAUDE.json nor CLAUDE.md exists」**整段替换**为（它原本的前提已被新行为推翻——现在会种 v1）：

```js
  it("seeds the default 王建硕 style as v1 when neither exists (default:true)", async () => {
    const { DEFAULT_STYLE } = await import("../../functions/lib/style-store.js");
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    const res = await onRequest(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.style).toBe(DEFAULT_STYLE);
    expect(body.head).toBe(1);
    expect(body.default).toBe(true);
    // 已落库为该用户自己的 CLAUDE.json
    expect(ctx.env.FILES._store.has(`${scope}CLAUDE.json`)).toBe(true);
  });

  it("default:false once the user has their own style", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 2,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "我自己的" }],
    }));
    const body = await (await onRequest(ctx)).json();
    expect(body.style).toBe("我自己的");
    expect(body.default).toBe(false);
  });
```

> 既有用例「falls back to the legacy CLAUDE.md 文风 section」**保持不变**——遗留用户 `ensureStyleSeeded` 返回 null，落回 legacy 分支，仍返回 `{style:"回退文风", legacy:true}`。它现在也是「不种覆盖老用户」的回归守卫。

- [ ] **Step 2: 运行确认失败**

Run: `cd agent && npx vitest run test/style-api.test.js`
Expected: FAIL —— 新用例期望 200/`default:true`，但当前实现返回 404。

- [ ] **Step 3: 加 import**

`functions/files/api/[[path]].js:23` 现为：

```js
import { readStyleDoc, writeStyleDoc, setStyleHead, resolveStyle, parseStyleMarkdown, readProfileName, mergeProfile } from "../../lib/style-store.js";
```

改为（加两个具名导入）：

```js
import { readStyleDoc, writeStyleDoc, setStyleHead, resolveStyle, parseStyleMarkdown, readProfileName, mergeProfile, ensureStyleSeeded, isDefaultSeed } from "../../lib/style-store.js";
```

- [ ] **Step 4: 改 GET 主分支**

把 `functions/files/api/[[path]].js:722-725` 的：

```js
    if (request.method === 'GET' && !subaction) {
      // `name` is additive (from doc.profile) — old clients decode only `style` and ignore it.
      const doc = await readStyleDoc(env, styleKey);
      if (doc) return json({ style: resolveStyle(doc), name: (doc.profile && doc.profile.name) || '', styles: (doc.profile && doc.profile.styles) || [], head: doc.head, createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0 });
```

替换为：

```js
    if (request.method === 'GET' && !subaction) {
      // `name` is additive (from doc.profile) — old clients decode only `style` and ignore it.
      // Lazy-seed: a user with no CLAUDE.json (and no legacy 文风) gets the default 王建硕
      // style materialized as their own v1 here, so the settings screen shows an editable
      // baseline instead of an empty box. `default:true` flags an un-edited seed.
      const doc = await ensureStyleSeeded(env, styleKey, legacyKey);
      if (doc) return json({ style: resolveStyle(doc), name: (doc.profile && doc.profile.name) || '', styles: (doc.profile && doc.profile.styles) || [], head: doc.head, createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0, default: isDefaultSeed(doc) });
```

> 其后的 legacy 分支（:726-732）一行不动——`ensureStyleSeeded` 对遗留用户返回 null，自然落到这里。

- [ ] **Step 5: 运行确认通过（含回归）**

Run: `cd agent && npx vitest run test/style-api.test.js`
Expected: PASS —— 新种子用例、`default:false` 用例、既有 legacy fallback 用例、`reads from CLAUDE.json` 用例全过。

- [ ] **Step 6: 提交**

```bash
git add functions/files/api/'[[path]].js' agent/test/style-api.test.js
git commit -m "feat(style): GET /style 懒种子默认文风为 v1，附 default 标记"
```

---

### Task 4: 接线 miner 主挖文路径

首次挖文时种 v1，使首篇文章基于真实 `v1` 生成并被打上 `风格 v1` 标签。

**Files:**
- Modify: `agent/src/miner.js:19`（import 加 `ensureStyleSeeded`）
- Modify: `agent/src/miner.js:882`（读 `styleDoc` 前插入一行）

**Interfaces:**
- Consumes: `ensureStyleSeeded`（Task 2）。
- Produces: 无新对外接口；行为变更——新用户首次挖文后 `users/<sub>/CLAUDE.json` 存在且 head=1（source default），现有 `headV`/`prependStyleComment` 逻辑自动给首篇打 `<!-- style: 风格 v1 -->`。

> **测试说明（诚实记录）**：种子逻辑本身已被 Task 2 的 `ensureStyleSeeded` 单测完整覆盖。本仓库惯例是从 DO alarm 里抽纯函数测（如 `usage_mine.test.js` 测 `meteredMineGate`），不对整个 alarm 做集成测试；mine alarm 方法依赖大量绑定，为这一行接线造集成测试不成比例。故本任务靠 **Task 2 单测 + 全量回归套件** 验证，不编造集成测试。

- [ ] **Step 1: 加 import**

`agent/src/miner.js:19` 现为：

```js
import { readStyleText, readProfileName, readStyleDoc, resolveStyle, prependStyleComment } from "../../functions/lib/style-store.js";
```

改为：

```js
import { readStyleText, readProfileName, readStyleDoc, resolveStyle, prependStyleComment, ensureStyleSeeded } from "../../functions/lib/style-store.js";
```

- [ ] **Step 2: 插入种子调用**

在 `agent/src/miner.js:882` 的 `const styleDoc = await readStyleDoc(env, scope + "CLAUDE.json");` **之前**插入：

```js
    // Lazy-seed the default 王建硕 style as v1 on first mine (no-op if the user
    // already has a style; skips legacy CLAUDE.md users). After this the first
    // article is tagged 风格 v1 and the user owns an editable baseline.
    await ensureStyleSeeded(env, scope + "CLAUDE.json", scope + "CLAUDE.md");
```

- [ ] **Step 3: 全量回归**

Run: `cd agent && npm test`
Expected: PASS —— 全部测试通过（已有用户行为不变；`style-store`/`style-api` 新测全过）。确认插入未破坏 mine 路径上任何依赖 `readStyleDoc`/`readStyleText` 回退的现有用例。

- [ ] **Step 4: 提交**

```bash
git add agent/src/miner.js
git commit -m "feat(style): miner 首次挖文懒种子默认文风为 v1（首篇标 风格 v1）"
```

---

## 验收（全部任务完成后）

- [ ] `cd agent && npm test` 全绿。
- [ ] 人工核对：新匿名用户调 `GET /files/api/style` → 200，`style` = 默认王建硕风格，`default:true`，且其 `CLAUDE.json` 已落库 head=1 source=default。
- [ ] 人工核对：该用户编辑文风（PUT）→ 再 `GET` → `default:false`，head=2。
- [ ] 人工核对：遗留 CLAUDE.md 用户 `GET /style` 仍返回其自己的文风 + `legacy:true`，未被默认覆盖。
- [ ] 部署：`cd agent && wrangler deploy`（agent worker）+ Pages Functions 随 `jianshuo.dev` 部署流程发布。
