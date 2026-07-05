# VoiceDrop 三预设文风 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新用户首次触碰文风时，种下三个预设版本（v1 王建硕 / v2 小红书 / v3 公众号，head=1），而不是现在的单版王建硕。

**Architecture:** 全部改动集中在 `functions/lib/style-store.js`（文风数据层单一真源）：加两段预设常量 + 一个纯函数 `seedPresetDoc()`，把 `ensureStyleSeeded` 的「无 doc」分支从写单版改成写三版，并把 `isDefaultSeed` 泛化为「未编辑的预设种子」判断。两个消费者（`miner.js` 首次挖矿、`[[path]].js` 的 GET /style `default` 标志）无需改动，注入层和 iOS 也不改。

**Tech Stack:** JavaScript ESM、vitest（`cd agent && vitest run`）、Cloudflare Pages Functions / Worker 共享 `functions/lib/`。

Spec：`docs/superpowers/specs/2026-07-05-voicedrop-style-presets-design.md`

## Global Constraints

- 只对**新用户**生效：`ensureStyleSeeded` 的存量分支（已有 doc / legacy 有文风）一字不改
- `head` 开局指向 v1 王建硕；三版 `source` 全为 `"preset"`
- 王建硕文本继续复用现有 `DEFAULT_STYLE` 常量（挖矿回退单一真源，不得复制）
- 测试在 agent 包跑：`cd ~/code/jianshuo.dev/agent && npx vitest run`
- 预设文本逐字来自已批准的 spec，不得改写

---

### Task 1: 三预设种子（数据层，纯逻辑 + 懒种子）

**Files:**
- Modify: `functions/lib/style-store.js`（加常量 `XHS_STYLE`/`WECHAT_STYLE`/`PRESET_STYLES`、纯函数 `seedPresetDoc`；改 `ensureStyleSeeded` 无-doc 分支；泛化 `isDefaultSeed`）
- Test: `agent/test/style-store.test.js`（改现有 3 个 ensureStyleSeeded/isDefaultSeed 用例 + 加 seedPresetDoc 用例）

**Interfaces:**
- Produces:
  - `XHS_STYLE: string`、`WECHAT_STYLE: string`（导出常量）
  - `PRESET_STYLES: {name:string, style:string}[]`（有序：王建硕 / 小红书 / 公众号）
  - `seedPresetDoc(now: number) -> {schema:3, head:1, versions:[{v,savedAt:now,source:"preset",style}×3], createdAt:now, updatedAt:now}`
  - `ensureStyleSeeded`（签名不变，新用户改种三版）
  - `isDefaultSeed(doc) -> boolean`（语义：仍是未编辑的三预设种子）

- [ ] **Step 1: 改测试到「三预设种子」预期**

在 `agent/test/style-store.test.js`：把 import 加上新符号，并改写 `ensureStyleSeeded` / `isDefaultSeed` 那组用例（原在 210-256 行附近，逐字替换整段 describe 块）：

```js
// import 行补上：
//   DEFAULT_STYLE, XHS_STYLE, WECHAT_STYLE, PRESET_STYLES,
//   seedPresetDoc, ensureStyleSeeded, isDefaultSeed,

describe("seedPresetDoc — 三预设种子", () => {
  it("三版 v1/v2/v3、head=1、source 全 preset、时间戳落位", () => {
    const doc = seedPresetDoc(1234);
    expect(doc.head).toBe(1);
    expect(doc.versions.map((e) => e.v)).toEqual([1, 2, 3]);
    expect(doc.versions.map((e) => e.source)).toEqual(["preset", "preset", "preset"]);
    expect(doc.versions.map((e) => e.style)).toEqual([DEFAULT_STYLE, XHS_STYLE, WECHAT_STYLE]);
    expect(doc.versions.every((e) => e.savedAt === 1234)).toBe(true);
    expect(doc.createdAt).toBe(1234);
    expect(doc.updatedAt).toBe(1234);
  });
  it("PRESET_STYLES 顺序 = 王建硕 / 小红书 / 公众号", () => {
    expect(PRESET_STYLES.map((p) => p.name)).toEqual(["王建硕", "小红书", "公众号"]);
    expect(PRESET_STYLES[0].style).toBe(DEFAULT_STYLE);
  });
});

describe("ensureStyleSeeded — 新用户种三预设，存量不动", () => {
  it("无 CLAUDE.json / 无 legacy → 种三版、head=1、isDefaultSeed=true", async () => {
    const env = fakeEnv({});
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.versions.map((e) => e.v)).toEqual([1, 2, 3]);
    expect(doc.head).toBe(1);
    expect(resolveStyle(doc)).toBe(DEFAULT_STYLE);        // 开局生效 = 王建硕
    expect(isDefaultSeed(doc)).toBe(true);
    expect(env.FILES._store.has(KEY)).toBe(true);
  });
  it("已有 CLAUDE.json → 原样返回，不被三预设覆盖", async () => {
    const existing = seedDoc([{ v: 1, savedAt: 1, source: "app", style: "我自己的" }], 1);
    const env = fakeEnv({ [KEY]: JSON.stringify(existing) });
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.versions).toHaveLength(1);
    expect(resolveStyle(doc)).toBe("我自己的");
    expect(isDefaultSeed(doc)).toBe(false);
  });
  it("legacy CLAUDE.md 有文风 → 返回 null，不种", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的文风\n老文风" });
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc).toBe(null);
    expect(env.FILES._store.has(KEY)).toBe(false);
  });
  it("幂等：种过再调 → 还是那三版，不叠加", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.versions.map((e) => e.v)).toEqual([1, 2, 3]);
  });
});

describe("isDefaultSeed — 未编辑的三预设种子", () => {
  it("刚种的三预设 → true", async () => {
    const env = fakeEnv({});
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(isDefaultSeed(doc)).toBe(true);
  });
  it("编辑后（多一版 / source 非 preset）→ false", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);
    const doc = await writeStyleDoc(env, KEY, "改过", "app");  // v4 source app
    expect(isDefaultSeed(doc)).toBe(false);
  });
  it("切了 head（比如切到小红书 v2）→ false", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);
    const doc = await setStyleHead(env, KEY, 2);
    expect(isDefaultSeed(doc)).toBe(false);
  });
  it("null / 空 → false", () => {
    expect(isDefaultSeed(null)).toBe(false);
    expect(isDefaultSeed({})).toBe(false);
  });
});
```

若 style-store.test.js 顶部 import 未含 `setStyleHead`，补上（前面 writeStyleDoc/setStyleHead 组已在用，通常已有）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/code/jianshuo.dev/agent && npx vitest run style-store 2>&1 | tail -20`
Expected: FAIL —— `seedPresetDoc`/`XHS_STYLE`/`WECHAT_STYLE`/`PRESET_STYLES` 未定义，且旧的单版预期不再成立。

- [ ] **Step 3: 实现 style-store.js**

在 `functions/lib/style-store.js` 的 `DEFAULT_STYLE` 常量之后、`ensureStyleSeeded` 之前，插入两段预设常量 + 预设表（文本逐字来自 spec）：

```js
// 小红书笔记体预设（seedPresetDoc 的 v2）。
export const XHS_STYLE = `小红书笔记体：短句、口语、有网感，一段最多两三行，读着像跟朋友唠。
开头第一句就抛钩子——痛点、反差或一个具体数字，别铺垫。
每张卡 / 每段只讲一个点，多用「你」，像当面说话。
适度用 emoji 点睛（一段零到两个，别每行都堆），亲切但不发嗲、不喊「宝子家人们」。
能列点就分行列，别写成大段。
结尾带三到五个话题标签（#xxx），挑跟内容真相关的。
不写「首先/其次/综上」，不写书面腔。`;

// 微信公众号文章体预设（seedPresetDoc 的 v3）。
export const WECHAT_STYLE = `微信公众号文章体：比口语更完整、比论文更亲切，面向广泛读者，不特指某一个人的嗓音。
开头直接进入话题、给出这篇要解决的问题，第一段就立住价值，不用小白式提问钩子。
用清晰的小标题分段，每段有节奏，长短句交替，读着不累。
观点先行、例证跟上；细节能列表就列表，不在叙述句里堆。
结尾留一句有回味的话或一个可带走的要点，不强行升华、不喊口号。
不堆 AI 味连接词（首先/其次/综上所述/值得注意的是），emoji 克制或不用。`;

// 三预设有序表（新用户种子来源）。王建硕复用 DEFAULT_STYLE 单一真源。
export const PRESET_STYLES = [
  { name: "王建硕", style: DEFAULT_STYLE },
  { name: "小红书", style: XHS_STYLE },
  { name: "公众号", style: WECHAT_STYLE },
];

// 构造未编辑的三预设种子信封（纯函数，便于单测，不碰 IO）。head=1（开局王建硕）。
export function seedPresetDoc(now) {
  return {
    schema: 3,
    head: 1,
    versions: PRESET_STYLES.map((p, i) => ({ v: i + 1, savedAt: now, source: "preset", style: p.style })),
    createdAt: now,
    updatedAt: now,
  };
}
```

把 `ensureStyleSeeded` 的写入分支从单版改成三版种子（其余分支不动）：

```js
export async function ensureStyleSeeded(env, styleKey, legacyKey) {
  const doc = await readStyleDoc(env, styleKey);
  if (doc) return doc;
  if (legacyKey) {
    const legacy = await env.FILES.get(legacyKey);
    if (legacy && parseStyleMarkdown(await legacy.text()).trim()) return null;
  }
  const seeded = seedPresetDoc(Date.now());
  await env.FILES.put(styleKey, JSON.stringify(seeded), { httpMetadata: { contentType: "application/json" } });
  return seeded;
}
```

把 `isDefaultSeed` 泛化为「未编辑的三预设种子」判断（三版、v 号连续 1/2/3、source 全 preset、head=1）：

```js
// True iff the doc is still the un-edited 3-preset seed: head=1, exactly the three
// preset versions (v1/v2/v3, source "preset"). Any edit (a v4, a non-preset source,
// or a moved head) makes it false. SINGLE SOURCE for the GET /style `default` flag.
export function isDefaultSeed(doc) {
  if (!doc || doc.head !== 1 || !Array.isArray(doc.versions)) return false;
  if (doc.versions.length !== PRESET_STYLES.length) return false;
  return doc.versions.every((e, i) => e.v === i + 1 && e.source === "preset");
}
```

同时把 `DEFAULT_STYLE` 上方注释里「Seeded as a user's own v1」那句更新为「seeded as v1 of the 3-preset chain」（保持注释不撒谎；非功能改动）。

- [ ] **Step 4: 跑测试确认通过（含全量回归）**

Run: `cd ~/code/jianshuo.dev/agent && npx vitest run style-store 2>&1 | tail -12`
Expected: PASS

Run: `npx vitest run 2>&1 | tail -20`
Expected: 全绿。特别确认 `style-api.test.js` 的 GET /style 用例仍过——`head=1` 时 `body.style === DEFAULT_STYLE`、`default:true` 都不变（王建硕仍是 v1）。若 `style-api` 里有断言「versions 长度=1」之类，按三预设更新为 3（逐字改断言，不改产品语义）。

- [ ] **Step 5: Commit**

```bash
cd ~/code/jianshuo.dev
git add functions/lib/style-store.js agent/test/style-store.test.js
git commit -m "feat(voicedrop): 新用户默认种三预设文风（王建硕/小红书/公众号）"
```

---

### Task 2: 部署与真机验证

**Files:** 无代码改动（Pages Functions + agent worker 部署）

- [ ] **Step 1: 部署**

按 jianshuo.dev 既有部署方式发 Pages Functions（`functions/lib/` 被 `functions/files/api` 和 agent worker 共用）。若 agent worker 单独部署，一并发。

- [ ] **Step 2: 真机验证（新匿名用户视角）**

- [ ] 用一个**全新**匿名 token 调 `GET /files/api/style` → 返回 `default:true`、`head:1`、`style` = 王建硕文本
- [ ] 该用户的 `CLAUDE.json` 里有三版（v1/v2/v3，source preset）——查 R2 或用 iOS 设置页看到三个版本 chip「王建硕 / 小红书 / 公众号」
- [ ] iOS 设置页切到 v2 → 生效文风变小红书；切 v3 → 公众号
- [ ] 存量用户回归：拿一个已有 CLAUDE.json 的老 token 调 GET /style → 仍是他原来的文风，未被三预设覆盖

- [ ] **Step 3: 收尾**

- 更新记忆 `08-infrastructure/` 或相关 VoiceDrop 记忆一句话：新用户默认三预设文风
- 若 spec/plan 有出入，回填
