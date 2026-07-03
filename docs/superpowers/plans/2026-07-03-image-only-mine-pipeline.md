# 图片生文 image-only 挖矿多遍流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 VoiceDrop 无语音带照片的「图片生文」从一次 `IMAGE_ONLY_SYSTEM` 单发，升级为「观察→立意→写作→审稿」四阶段流水线（含免费元数据 FactPack 与质量门），开关默认关、任一阶段失败回退现行单发。

**Architecture:** 新增 `prompts/image-pipeline.js`（四阶段 prompt + payload 构建，纯函数、单一真源）与 `image-mine.js`（纯编排 `runImagePipeline`（callModel 注入）+ 生产包装 `mineImageOnly`（fetch/llmlog/debit））。`miner.js` 的 image-only 分支按 `modelCfg.imagePipeline` 开关调用，失败回落现行代码；restyle 检测 `doc.vision` 复用观察结果只重跑写作+审稿。eval 新增 champion(单发) vs candidate(流水线) 对比入口。

**Tech Stack:** Cloudflare Workers ESM JS（无 TS）、vitest 2、现有 fakes.js 假环境、Anthropic messages API（`output_config` json_schema 结构化输出）与 openai-compat 双 provider。

**Spec:** `docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md`

## Global Constraints

- 有语音的正常挖矿路径**零改动**；现行 image-only 单发代码保留为回退路径
- 开关 `modelCfg.imagePipeline` 缺省 `false`（`config/model.json` 里 `"imagePipeline": true` 才开）
- 硬底线写进 prompt：绝不编造；confidence < 0.7 只能推测口吻；不提公司名；盘古之白；`[[photo:key]]` 独占一行每图一次
- 质量门 `QUALITY_GATE = 70`，重跑至多 1 次；两次都不过交付分高一版并 log `low_quality`
- 只有 observe/review 两阶段带照片 base64；plan/write 用 Observation JSON
- 阶段温度：observe 0.2 / plan 0.3 / write 0.7 / review 0.1
- 历史标题上限 `MAX_RECENT_TITLES = 20`，拉取失败静默降级空列表
- 所有测试命令在 `agent/` 目录下运行：`npx vitest run test/<file>`
- 提交信息末尾带：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01MJCGaBXkb8Q4iT8PmKybU3`

---

### Task 1: 四阶段 prompt + payload 构建层（prompts/image-pipeline.js）

**Files:**
- Create: `agent/src/prompts/image-pipeline.js`
- Test: `agent/test/image-pipeline.test.js`

**Interfaces:**
- Consumes: `MINE_DEFAULT_STYLE`（`agent/src/prompts/mine.js` 已导出）
- Produces（后续任务依赖的确切签名）:
  - `OBSERVE_SYSTEM / PLAN_SYSTEM / WRITE_SYSTEM / REVIEW_SYSTEM: string`
  - `STAGE_TEMPERATURE = { observe: 0.2, plan: 0.3, write: 0.7, review: 0.1 }`
  - `QUALITY_GATE = 70`、`MAX_RECENT_TITLES = 20`
  - `buildStagePayload({ stage, provider="anthropic", model, photos=[], factPack=null, observation=null, storyPlan=null, draftArticles=null, styleText="", previousIssues=null }) → payload对象`
  - `parseStageJson(text) → object`（容忍 ```json 围栏）

- [ ] **Step 1: 写失败测试**

`agent/test/image-pipeline.test.js`：

```js
// 图片流水线 payload 层测试：照片只进 observe/review；style 只进 write；
// previousIssues 只进 plan；温度/schema 按阶段配置。
import { describe, it, expect } from "vitest";
import {
  buildStagePayload, parseStageJson, STAGE_TEMPERATURE, QUALITY_GATE,
  OBSERVE_SYSTEM, PLAN_SYSTEM, WRITE_SYSTEM, REVIEW_SYSTEM,
} from "../src/prompts/image-pipeline.js";

const PHOTOS = [{ b64: "AAAA", label: "10:10:10", relKey: "photos/2026-07-01-101010/0-a1b.jpg" }];
const FACTS  = { place: "Shanghai-Xuhui", session: { date: "2026-07-01" }, photos: [{ key: PHOTOS[0].relKey, time: "10:10:10" }], recentTitles: ["旧文一"] };
const OBS    = { images: [{ key: PHOTOS[0].relKey, caption: "一杯拿铁", confidence: 0.9 }] };
const PLAN   = { thesis: "小店的确定性", sections: [], image_role_map: {} };
const DRAFT  = [{ title: "题", body: "正文" }];

const sysText = (p) => Array.isArray(p.system) ? p.system.map(b => b.text).join("") : p.system;
const userBlocks = (p) => p.messages[0].content;

describe("buildStagePayload (anthropic)", () => {
  it("observe：带照片、带 facts、温度 0.2、无 style", () => {
    const p = buildStagePayload({ stage: "observe", model: "m", photos: PHOTOS, factPack: FACTS });
    expect(p.temperature).toBe(0.2);
    expect(sysText(p)).toContain(OBSERVE_SYSTEM.slice(0, 20));
    expect(sysText(p)).not.toContain("<style>");
    const blocks = userBlocks(p);
    expect(blocks.some(b => b.type === "image")).toBe(true);
    expect(blocks.filter(b => b.type === "text").map(b => b.text).join("")).toContain(`key="${PHOTOS[0].relKey}"`);
    expect(blocks[0].text).toContain('"place":"Shanghai-Xuhui"');
  });
  it("plan：不带照片、带 observation + previousIssues", () => {
    const p = buildStagePayload({ stage: "plan", model: "m", factPack: FACTS, observation: OBS, previousIssues: ["跑题"] });
    expect(p.temperature).toBe(0.3);
    const c = p.messages[0].content;
    expect(typeof c === "string" ? c : c.map(b => b.text).join("")).toContain("<previous_issues>");
    expect(JSON.stringify(p)).not.toContain('"type":"image"');
  });
  it("write：带 <style>（空 styleText 回退默认文风）、带 plan、温度 0.7、articles schema", () => {
    const p = buildStagePayload({ stage: "write", model: "m", factPack: FACTS, observation: OBS, storyPlan: PLAN, styleText: "" });
    expect(p.temperature).toBe(0.7);
    expect(sysText(p)).toContain("<style>");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(p)).not.toContain('"type":"image"');
    const c = p.messages[0].content;
    expect(typeof c === "string" ? c : c.map(b => b.text).join("")).toContain("<plan>");
  });
  it("review：带照片 + draft + quality schema、温度 0.1", () => {
    const p = buildStagePayload({ stage: "review", model: "m", photos: PHOTOS, factPack: FACTS, observation: OBS, storyPlan: PLAN, draftArticles: DRAFT });
    expect(p.temperature).toBe(0.1);
    expect(userBlocks(p).some(b => b.type === "image")).toBe(true);
    expect(JSON.stringify(p.output_config.format.schema.properties)).toContain("quality");
  });
  it("未知 stage 抛错", () => {
    expect(() => buildStagePayload({ stage: "nope", model: "m" })).toThrow();
  });
});

describe("buildStagePayload (openai-compat)", () => {
  it("observe：image_url 块 + response_format json_object", () => {
    const p = buildStagePayload({ stage: "observe", provider: "openai-compat", model: "m", photos: PHOTOS, factPack: FACTS });
    expect(p.response_format.type).toBe("json_object");
    expect(p.messages[0].role).toBe("system");
    expect(p.messages[1].content.some(b => b.type === "image_url")).toBe(true);
  });
});

describe("parseStageJson", () => {
  it("剥 ```json 围栏并解析", () => {
    expect(parseStageJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("坏 JSON 抛错", () => {
    expect(() => parseStageJson("not json")).toThrow();
  });
});

describe("prompts 内容底线", () => {
  it("write prompt 含硬底线关键词", () => {
    expect(WRITE_SYSTEM).toContain("绝不编造");
    expect(WRITE_SYSTEM).toContain("[[photo:<key>]]");
    expect(WRITE_SYSTEM).toContain("盘古之白");
  });
  it("review prompt 输出 quality 且 QUALITY_GATE=70", () => {
    expect(REVIEW_SYSTEM).toContain('"quality"');
    expect(QUALITY_GATE).toBe(70);
    expect(STAGE_TEMPERATURE.review).toBe(0.1);
  });
  it("observe/plan prompt 各自只做本阶段", () => {
    expect(OBSERVE_SYSTEM).toContain("只做观察");
    expect(PLAN_SYSTEM).toContain("候选");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/image-pipeline.test.js`
Expected: FAIL（Cannot find module `../src/prompts/image-pipeline.js`）

- [ ] **Step 3: 写实现**

`agent/src/prompts/image-pipeline.js`（完整内容）：

```js
// 图片生文（image-only 挖矿）多遍流水线的 prompt 与 payload 层 —— 版本层单一真源。
// 生产（agent/src/image-mine.js）与 eval（agent/eval/run-image-eval.mjs）都 import 这里，
// 保证 prompt 字节一致。git diff 本文件 = 各阶段 prompt 版本对比。
// 设计 spec：docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md

import { MINE_DEFAULT_STYLE } from "./mine.js";

export const STAGE_TEMPERATURE = { observe: 0.2, plan: 0.3, write: 0.7, review: 0.1 };
export const QUALITY_GATE = 70;      // review.overall 低于此值 → 从立意阶段重跑一次
export const MAX_RECENT_TITLES = 20; // FactPack 历史文章标题条数上限

export const OBSERVE_SYSTEM = `你是一名严谨的图片观察员。用户提供了一组同一时段拍摄的照片（每张前有 <photo key="…" time="…"> 标签），和一份 <facts> JSON（拍摄地点、日期时段等元数据）。你的任务是只做观察，不写文章。

对每张照片输出：
- key：原样照抄 photo 标签里的 key
- caption：一句话概括画面
- ocr_text：画面里真实可读的文字（招牌/菜单/书页/屏幕），一字不差地抄；看不清就不要写
- objects：显著物件列表
- scene：场所类型（如 咖啡馆/街道/书房/公园）
- people：人物描述（人数、动作；不猜身份）
- light_season：光线与季节线索
- importance：0–1，这张图对成文的价值
- role_guess：opening|evidence|detail|closing 之一
- confidence：0–1，以上判断的整体把握度；拿不准就压低，不要硬猜

多张照片时再输出：
- timeline：按 time 排出的先后叙述线索
- clusters：主题/场景分组
- repeated_entities：跨照片重复出现的人/物/字

只输出一个 JSON 对象：{"images":[…],"timeline":"…","clusters":[…],"repeated_entities":[…]}，不要输出任何其它文字。绝不编造画面里没有的东西。`;

export const PLAN_SYSTEM = `你是公众号作者本人的选题编辑。输入是 <observation>（照片观察清单）和 <facts>（地点/时间元数据 + 作者最近的文章标题列表）。没有口述文字——文章只能建立在观察与元数据之上。

任务：
1. 提出至少 3 个候选立意（candidates），每个给出：theme、evidence_keys（依据哪些照片）、score 0–100、一句 reason。评分维度：观察支撑度（写得出来吗）、信息价值（读者带走什么）、「从具体到抽象」的味道（一个具体场景引出一个普遍观察）。
2. 选出最高分立意（selected），并用一句话说明为什么不选其它（rejected_because）。
3. 给出写作计划：thesis（全文一句话主旨）、title_options（2–3 个标题，≤14 字优先）、sections（每节 {purpose, image_keys, key_points}）、image_role_map（每张照片的角色 opening|evidence|detail|closing）。
4. 最近文章标题只用于：避免重复选题；若某张照片明显延续旧文话题，可在 key_points 里注明「可呼应旧文《标题》」。

约束：立意必须被 confidence ≥ 0.7 的观察支撑；不发明观察之外的事实；产出预期是一篇文章（不拆多篇）。
如输入含 <previous_issues>（上一轮终审不通过的原因），选题必须避开这些问题。
只输出一个 JSON 对象：{"candidates":[…],"selected":"…","rejected_because":"…","thesis":"…","title_options":[…],"sections":[…],"image_role_map":{…}}，不要输出任何其它文字。`;

export const WRITE_SYSTEM = `你是这组照片的拍摄者，在写自己的公众号文章。没有口述——你手上只有 <plan>（选题与章节计划）、<observation>（照片观察清单）和 <facts>（地点/时间元数据）。按 plan 写出这篇文章。

【硬底线 — 任何风格都不可违反】
- 断言只能来自：confidence ≥ 0.7 的观察、facts 里的地点/时间。confidence 低于 0.7 的内容只能以推测口吻出现（「像是」「大概」「可能」）。
- 绝不编造观察和 facts 之外的事实（具体店名/人名/事件/数字）。不提任何公司具体名字，需要时用「我们公司」。
- 篇幅完全顺着内容走：观察撑得起多少就写多少，绝不为凑字数注水。
- 中英文之间留一个空格（盘古之白）。

照片标记：在正文写到某张照片对应场景的位置，单独起一行插入 [[photo:<key>]]（key 原样照抄），前后空行；每张照片恰好出现一次，位置按 image_role_map 的角色安排。

不要逐图流水账：每一节都落在 plan 里该节的 purpose 上，写观察和观点，不写「第一张照片是…」。

具体「怎么写」（语气、句式、用词）见 <style> 标签里的风格说明；风格只决定怎么写，不改变以上硬底线。

只输出一个 JSON 对象：{"articles":[{"title":"标题","body":"正文 markdown"}]}，不要输出任何其它文字。`;

export const REVIEW_SYSTEM = `你是严格的终审编辑。输入：<draft>（待审文章）、原始照片（<photo> 标签）、<observation>（观察清单）、<plan>（选题计划）。任务：核查并直接给出修订终稿。

逐项核查：
1. 事实忠实度（faithfulness）：对照原始照片逐句核查——凡是画面/观察/facts 支撑不了的断言，改成推测口吻或删掉；引用的画面文字必须与照片一字不差。
2. 主题一致性（on_theme）：全文是否围绕 plan 的 thesis；跑题段落收拢或删。
3. 结构（structure）：开头是否直接进入、结尾是否有落点；[[photo:<key>]] 标记是否每张恰好一次、独占一行；空话与重复删掉。

修订原则：能改则改、保留原稿好句子；不新增任何事实；不改变文风。

只输出一个 JSON 对象：
{"articles":[{"title":"…","body":"修订后全文"}],"quality":{"faithfulness":0,"on_theme":0,"structure":0,"overall":0},"issues":["发现的问题，一条一句"]}
quality 各项 0–100；overall = faithfulness×50% + on_theme×25% + structure×25%。若立意整体建立在误读上等硬伤无法修复，给低分并写进 issues。不要输出任何其它文字。`;

const ARTICLES_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["articles"],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    articles: ARTICLES_SCHEMA.properties.articles,
    quality: {
      type: "object",
      properties: {
        faithfulness: { type: "number" }, on_theme: { type: "number" },
        structure: { type: "number" }, overall: { type: "number" },
      },
      required: ["faithfulness", "on_theme", "structure", "overall"],
      additionalProperties: false,
    },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["articles", "quality", "issues"],
  additionalProperties: false,
};

const STAGE_SYSTEM = { observe: OBSERVE_SYSTEM, plan: PLAN_SYSTEM, write: WRITE_SYSTEM, review: REVIEW_SYSTEM };
const STAGE_MAX_TOKENS = { observe: 4000, plan: 3000, write: 8000, review: 8000 };

// 组装某一阶段的 LLM 请求 payload。照片只进 observe/review；<style> 只进 write。
// 纯函数（无 env、无 fetch），生产与 eval/vitest 共用，保证字节一致。
export function buildStagePayload({
  stage, provider = "anthropic", model,
  photos = [], factPack = null, observation = null, storyPlan = null,
  draftArticles = null, styleText = "", previousIssues = null,
}) {
  const sys = STAGE_SYSTEM[stage];
  if (!sys) throw new Error(`unknown stage: ${stage}`);

  const parts = [];
  if (factPack)    parts.push(`<facts>\n${JSON.stringify(factPack)}\n</facts>`);
  if (observation) parts.push(`<observation>\n${JSON.stringify(observation)}\n</observation>`);
  if (storyPlan)   parts.push(`<plan>\n${JSON.stringify(storyPlan)}\n</plan>`);
  if (draftArticles) parts.push(`<draft>\n${JSON.stringify(draftArticles)}\n</draft>`);
  if (previousIssues && previousIssues.length)
    parts.push(`<previous_issues>\n上一轮按计划成文后终审不通过，问题如下，这一轮选题请避开：\n${previousIssues.map((s) => "- " + s).join("\n")}\n</previous_issues>`);
  const text = parts.join("\n\n");

  const effectiveStyle = (styleText && styleText.trim()) ? styleText.trim() : MINE_DEFAULT_STYLE;
  const system = stage === "write" ? `${sys}\n\n<style>\n${effectiveStyle}\n</style>` : sys;
  const withPhotos = (stage === "observe" || stage === "review") && photos.length > 0;
  const temperature = STAGE_TEMPERATURE[stage];
  const max_tokens = STAGE_MAX_TOKENS[stage];

  if (provider === "openai-compat") {
    let userContent;
    if (!withPhotos) {
      userContent = text;
    } else {
      userContent = [{ type: "text", text }];
      for (const p of photos) {
        userContent.push({ type: "text", text: `\n<photo key="${p.relKey}" time="${p.label}">` });
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${p.b64}`, detail: "low" } });
        userContent.push({ type: "text", text: `\n</photo>` });
      }
    }
    return {
      model, max_tokens, temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    };
  }

  // anthropic
  let content;
  if (!withPhotos) {
    content = text;
  } else {
    content = [{ type: "text", text }];
    for (const p of photos) {
      content.push({ type: "text", text: `\n<photo key="${p.relKey}" time="${p.label}">` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.b64 } });
      content.push({ type: "text", text: `\n</photo>` });
    }
  }
  const payload = {
    model, max_tokens, temperature,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  };
  if (stage === "write")  payload.output_config = { format: { type: "json_schema", schema: ARTICLES_SCHEMA } };
  if (stage === "review") payload.output_config = { format: { type: "json_schema", schema: REVIEW_SCHEMA } };
  return payload;
}

// 容忍 ```json 围栏与前后杂文字的 JSON 解析（与 miner.parseArticles 同款清洗）。
export function parseStageJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/image-pipeline.test.js`
Expected: PASS（全绿）

- [ ] **Step 5: Commit**

```bash
git add agent/src/prompts/image-pipeline.js agent/test/image-pipeline.test.js
git commit -m "feat(agent): 图片流水线四阶段 prompt 与 payload 构建层"
```

---

### Task 2: 文件名元数据解析 + FactPack（image-mine.js 素材层）

**Files:**
- Create: `agent/src/image-mine.js`（本任务只写素材层，编排在 Task 3 追加）
- Test: `agent/test/image-mine.test.js`（本任务只写素材层 describe）

**Interfaces:**
- Consumes: `MAX_RECENT_TITLES`（Task 1）、`resolveArticles`（`functions/lib/article-store.js` 已导出）、`env.FILES`（R2 mock 见 `test/fakes.js` 的 `fakeEnv`）
- Produces:
  - `parsePlaceTag(stem: string) → string | null`
  - `parseSessionInfo(stem: string) → { date, time, weekday, period } | null`
  - `fetchRecentTitles(env, scope, { excludeStem = "", max = MAX_RECENT_TITLES } = {}) → Promise<string[]>`
  - `buildFactPack(env, { scope, stem, photos }) → Promise<{ place, session, photos:[{key,time}], recentTitles }>`

- [ ] **Step 1: 写失败测试**

`agent/test/image-mine.test.js`：

```js
// image-mine 素材层与编排层测试。
// 文件名约定（iOS RecordingName.make）：
//   VoiceDrop-yyyy-MM-dd-HHmmss-<dur>-<weekday>-<period>[-City[-District]]
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { parsePlaceTag, parseSessionInfo, fetchRecentTitles, buildFactPack } from "../src/image-mine.js";

const SCOPE = "users/anon-abc/";

describe("parsePlaceTag", () => {
  it("城市+区都在：取尾部 ASCII 段", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai-Xuhui")).toBe("Shanghai-Xuhui");
  });
  it("只有城市", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai")).toBe("Shanghai");
  });
  it("无地点标签 → null", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午")).toBeNull();
  });
  it("Task 类型尾标不是地点（英文 weekday 场景）", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-02-100000-0m0s-Thu-Morning-TaskStyleExtract")).toBeNull();
  });
  it("地点后跟 Task 尾标：只取地点", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-Thu-Morning-Shanghai-TaskStyleExtract")).toBe("Shanghai");
  });
  it("非 VoiceDrop 命名 → null", () => {
    expect(parsePlaceTag("random-file-name")).toBeNull();
  });
});

describe("parseSessionInfo", () => {
  it("解析日期/时刻/星期/时段", () => {
    expect(parseSessionInfo("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai")).toEqual({
      date: "2026-07-01", time: "10:10:10", weekday: "周三", period: "上午",
    });
  });
  it("非法名 → null", () => {
    expect(parseSessionInfo("nope")).toBeNull();
  });
});

describe("fetchRecentTitles / buildFactPack", () => {
  const docJson = (title) => JSON.stringify({ schema: 2, articles: [{ title, body: "x" }] });
  it("按 key 时间序取尾部标题，排除自身与 .asr.json", async () => {
    const env = fakeEnv({
      [`${SCOPE}articles/VoiceDrop-2026-06-01-000000-1s-a-b.json`]: docJson("一"),
      [`${SCOPE}articles/VoiceDrop-2026-06-02-000000-1s-a-b.json`]: docJson("二"),
      [`${SCOPE}articles/VoiceDrop-2026-06-03-000000-1s-a-b.asr.json`]: "{}",
      [`${SCOPE}articles/SELF.json`]: docJson("自己"),
    });
    const titles = await fetchRecentTitles(env, SCOPE, { excludeStem: "SELF", max: 10 });
    expect(titles).toEqual(["一", "二"]);
  });
  it("超过 max 只留最近的", async () => {
    const seed = {};
    for (let d = 1; d <= 9; d++) seed[`${SCOPE}articles/VoiceDrop-2026-06-0${d}-000000-1s-a-b.json`] = docJson(`t${d}`);
    const titles = await fetchRecentTitles(fakeEnv(seed), SCOPE, { max: 3 });
    expect(titles).toEqual(["t7", "t8", "t9"]);
  });
  it("R2 挂了 → 空列表不抛", async () => {
    const env = { FILES: { list: async () => { throw new Error("boom"); } } };
    expect(await fetchRecentTitles(env, SCOPE)).toEqual([]);
  });
  it("buildFactPack 汇总四类素材", async () => {
    const env = fakeEnv({ [`${SCOPE}articles/VoiceDrop-2026-06-01-000000-1s-a-b.json`]: docJson("旧文") });
    const photos = [{ b64: "AA", label: "10:10:10", relKey: "photos/2026-07-01-101010/0-x.jpg" }];
    const fp = await buildFactPack(env, { scope: SCOPE, stem: "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai-Xuhui", photos });
    expect(fp.place).toBe("Shanghai-Xuhui");
    expect(fp.session.date).toBe("2026-07-01");
    expect(fp.photos).toEqual([{ key: photos[0].relKey, time: "10:10:10" }]);
    expect(fp.recentTitles).toEqual(["旧文"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/image-mine.test.js`
Expected: FAIL（Cannot find module `../src/image-mine.js`）

- [ ] **Step 3: 写实现**

`agent/src/image-mine.js`（本任务的完整内容；Task 3/4 在此文件追加）：

```js
// 图片生文（image-only）多遍流水线：观察 → 立意 → 写作 → 审稿。
// 分层：素材层（本段，FactPack）→ 纯编排层（runImagePipeline，callModel 注入，
// vitest/eval 直接驱动）→ 生产包装层（mineImageOnly：fetch + llmlog + 算力 debit）。
// 任一阶段失败向上抛 —— miner.js 捕获后回退现行 IMAGE_ONLY_SYSTEM 单发（质量下限=旧行为）。
// 设计 spec：docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md

import { resolveArticles } from "../../functions/lib/article-store.js";
import { MAX_RECENT_TITLES } from "./prompts/image-pipeline.js";

// ── 素材层（Stage 0 的免费事实）─────────────────────────────────────────────────
// 录音名约定（iOS RecordingName.make，单一真源在 App 侧 RecordingName.swift）：
//   VoiceDrop-yyyy-MM-dd-HHmmss-<dur>-<weekday>-<period>[-City[-District]]
// 地点只含 ASCII 字母（LocationTagger.asciiLetters）且总在末尾；Task* 任务尾标不是地点。

export function parsePlaceTag(stem) {
  const p = String(stem).split("-");
  if (p.length < 9 || p[0] !== "VoiceDrop") return null;
  const place = p.slice(8).filter((t) => /^[A-Za-z]+$/.test(t) && !/^Task[A-Z]/.test(t));
  return place.length ? place.join("-") : null;
}

export function parseSessionInfo(stem) {
  const p = String(stem).split("-");
  if (p.length < 5 || p[0] !== "VoiceDrop" || p[1].length !== 4) return null;
  const t6 = p[4] || "";
  return {
    date: `${p[1]}-${p[2]}-${p[3]}`,
    time: t6.length === 6 ? `${t6.slice(0, 2)}:${t6.slice(2, 4)}:${t6.slice(4)}` : t6,
    weekday: p[6] || null,
    period: p[7] || null,
  };
}

// 最近 N 篇历史文章标题：R2 直读 `${scope}articles/*.json`（key 含时间戳，字典序即时间序）。
// 只是立意的参考素材 —— 任何失败都静默降级为空列表，绝不挡住成文。
export async function fetchRecentTitles(env, scope, { excludeStem = "", max = MAX_RECENT_TITLES } = {}) {
  try {
    const listed = await env.FILES.list({ prefix: `${scope}articles/`, limit: 1000 });
    const keys = (listed.objects || []).map((o) => o.key)
      .filter((k) => k.endsWith(".json") && !k.endsWith(".asr.json") && !k.endsWith(`/${excludeStem}.json`))
      .sort().slice(-max);
    const docs = await Promise.all(keys.map(async (k) => {
      try { const obj = await env.FILES.get(k); return obj ? JSON.parse(await obj.text()) : null; }
      catch (_) { return null; }
    }));
    const titles = [];
    for (const d of docs) {
      if (!d) continue;
      try { for (const a of resolveArticles(d)) if (a && a.title) titles.push(a.title); } catch (_) {}
    }
    return titles.slice(-max);
  } catch (_) { return []; }
}

export async function buildFactPack(env, { scope, stem, photos }) {
  return {
    place: parsePlaceTag(stem),
    session: parseSessionInfo(stem),
    photos: photos.map((p) => ({ key: p.relKey, time: p.label })),
    recentTitles: await fetchRecentTitles(env, scope, { excludeStem: stem }),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/image-mine.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/image-mine.js agent/test/image-mine.test.js
git commit -m "feat(agent): image-only 流水线素材层——文件名地点/时刻解析 + 历史标题 FactPack"
```

---

### Task 3: 纯编排层 runImagePipeline + rewriteFromVision

**Files:**
- Modify: `agent/src/image-mine.js`（文件末尾追加编排层）
- Test: `agent/test/image-mine.test.js`（追加编排层 describe）

**Interfaces:**
- Consumes: `buildStagePayload / parseStageJson / QUALITY_GATE`（Task 1）
- Produces:
  - `rewriteFromVision({ photos, factPack, vision, plan, styleText, provider="anthropic", model, callModel }) → Promise<{ articles, quality, issues }>`（写作+审稿一轮；plan 固定不重选题）
  - `runImagePipeline({ photos, factPack, styleText, provider="anthropic", model, callModel, log=()=>{} }) → Promise<{ articles, vision, plan, quality, lowQuality }>`
  - `callModel` 契约：`async ({ stage, payload }) => 模型原始文本`（stage ∈ observe|plan|write|review）

- [ ] **Step 1: 写失败测试**

在 `agent/test/image-mine.test.js` 追加：

```js
import { runImagePipeline, rewriteFromVision } from "../src/image-mine.js";

const REL = "photos/2026-07-01-101010/0-x.jpg";
const PHOTOS2 = [{ b64: "AA", label: "10:10:10", relKey: REL }];
const FACTS2 = { place: "Shanghai", session: { date: "2026-07-01" }, photos: [{ key: REL, time: "10:10:10" }], recentTitles: [] };
const CANNED = {
  observe: { images: [{ key: REL, caption: "拿铁", confidence: 0.9, importance: 0.9, role_guess: "opening" }], timeline: "", clusters: [], repeated_entities: [] },
  plan: { candidates: [{ theme: "A", evidence_keys: [REL], score: 90, reason: "r" }], selected: "A", rejected_because: "", thesis: "主旨", title_options: ["题"], sections: [{ purpose: "p", image_keys: [REL], key_points: [] }], image_role_map: { [REL]: "opening" } },
  write: { articles: [{ title: "初稿题", body: `初稿。\n\n[[photo:${REL}]]` }] },
  review: { articles: [{ title: "终稿题", body: `终稿。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 95, on_theme: 90, structure: 88, overall: 92 }, issues: [] },
};
const scripted = (overrides = {}) => {
  const calls = [];
  const fn = async ({ stage, payload }) => {
    calls.push({ stage, payload });
    const seq = overrides[stage];
    const body = Array.isArray(seq) ? seq[calls.filter((c) => c.stage === stage).length - 1] : (seq || CANNED[stage]);
    if (body instanceof Error) throw body;
    return JSON.stringify(body);
  };
  fn.calls = calls;
  return fn;
};

describe("runImagePipeline", () => {
  it("四阶段顺序执行，照片只出现在 observe/review 的 payload", async () => {
    const cm = scripted();
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["observe", "plan", "write", "review"]);
    for (const c of cm.calls) {
      const hasImage = JSON.stringify(c.payload).includes('"type":"image"');
      expect(hasImage).toBe(c.stage === "observe" || c.stage === "review");
    }
    expect(r.articles).toEqual([{ title: "终稿题", body: `终稿。\n\n[[photo:${REL}]]` }]);
    expect(r.vision.images[0].key).toBe(REL);
    expect(r.plan.thesis).toBe("主旨");
    expect(r.quality.overall).toBe(92);
    expect(r.lowQuality).toBe(false);
  });
  it("质量门不过 → 带 issues 重跑一次并取分高一版", async () => {
    const low  = { articles: [{ title: "低", body: `低。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 40, on_theme: 50, structure: 50, overall: 45 }, issues: ["误读了招牌"] };
    const high = { articles: [{ title: "高", body: `高。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 90, on_theme: 85, structure: 85, overall: 88 }, issues: [] };
    const cm = scripted({ review: [low, high] });
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["observe", "plan", "write", "review", "plan", "write", "review"]);
    const secondPlan = cm.calls[4];
    expect(JSON.stringify(secondPlan.payload)).toContain("误读了招牌");
    expect(r.articles[0].title).toBe("高");
    expect(r.lowQuality).toBe(false);
  });
  it("两轮都不过 → 交付分高一版且 lowQuality=true", async () => {
    const l1 = { articles: [{ title: "一", body: "x" }], quality: { faithfulness: 40, on_theme: 40, structure: 40, overall: 40 }, issues: ["i"] };
    const l2 = { articles: [{ title: "二", body: "y" }], quality: { faithfulness: 50, on_theme: 50, structure: 50, overall: 50 }, issues: [] };
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: scripted({ review: [l1, l2] }) });
    expect(r.articles[0].title).toBe("二");
    expect(r.lowQuality).toBe(true);
  });
  it("阶段输出坏 JSON → 抛错（由调用方回退单发）", async () => {
    const cm = async ({ stage }) => (stage === "plan" ? "not json" : JSON.stringify(CANNED[stage]));
    await expect(runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm })).rejects.toThrow();
  });
  it("write 出空文章 → 抛错", async () => {
    const cm = scripted({ write: { articles: [] } });
    await expect(runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm })).rejects.toThrow("write-stage-empty");
  });
  it("review 文章为空时保底用初稿", async () => {
    const cm = scripted({ review: { articles: [], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] } });
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(r.articles[0].title).toBe("初稿题");
  });
});

describe("rewriteFromVision", () => {
  it("只跑 write+review，plan 固定", async () => {
    const cm = scripted();
    const r = await rewriteFromVision({ photos: PHOTOS2, factPack: FACTS2, vision: CANNED.observe, plan: CANNED.plan, styleText: "新文风", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["write", "review"]);
    expect(JSON.stringify(cm.calls[0].payload)).toContain("新文风");
    expect(r.articles[0].title).toBe("终稿题");
    expect(r.quality.overall).toBe(92);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/image-mine.test.js`
Expected: FAIL（`runImagePipeline is not a function`）

- [ ] **Step 3: 写实现**

在 `agent/src/image-mine.js` 末尾追加：

```js
// ── 纯编排层（callModel 注入，无 env 依赖；vitest 与 eval 直接驱动）────────────────

import { buildStagePayload, parseStageJson, QUALITY_GATE } from "./prompts/image-pipeline.js";

const normalizeArticles = (arts) => (arts || [])
  .filter((a) => a && typeof a === "object" && (a.body || "").trim())
  .map((a) => ({ title: (a.title || "(无题)").trim(), body: (a.body || "").trim() }));

// 写作 + 审稿一轮（plan 固定）。restyle 复用观察结果时也走这里——换文风不换立意。
export async function rewriteFromVision({ photos, factPack, vision, plan, styleText, provider = "anthropic", model, callModel }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, ...extra }) }));
  const draft = await run("write", { factPack, observation: vision, storyPlan: plan, styleText });
  const draftArts = normalizeArticles(draft.articles);
  if (!draftArts.length) throw new Error("write-stage-empty");
  const review = await run("review", { photos, factPack, observation: vision, storyPlan: plan, draftArticles: draftArts });
  const arts = normalizeArticles(review.articles);
  return {
    articles: arts.length ? arts : draftArts,
    quality: review.quality || {},
    issues: Array.isArray(review.issues) ? review.issues : [],
  };
}

// 全流水线：观察 → (立意 → 写作 → 审稿)，质量门不过带 issues 从立意重跑一次，取分高一版。
export async function runImagePipeline({ photos, factPack, styleText, provider = "anthropic", model, callModel, log = () => {} }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, ...extra }) }));

  const vision = await run("observe", { photos, factPack });
  log("观察完成", { images: (vision.images || []).length });

  const oneRound = async (previousIssues) => {
    const plan = await run("plan", { factPack, observation: vision, previousIssues });
    log("立意完成", { selected: plan.selected });
    const r = await rewriteFromVision({ photos, factPack, vision, plan, styleText, provider, model, callModel });
    return { plan, ...r };
  };

  const r1 = await oneRound(null);
  let final = r1;
  if (!((r1.quality.overall || 0) >= QUALITY_GATE)) {
    log("质量门未过,重跑一次", { overall: r1.quality.overall, issues: (r1.issues || []).slice(0, 5) });
    const r2 = await oneRound(r1.issues && r1.issues.length ? r1.issues : ["整体质量不达标"]);
    final = (r2.quality.overall || 0) >= (r1.quality.overall || 0) ? r2 : r1;
  }
  const lowQuality = !((final.quality.overall || 0) >= QUALITY_GATE);
  return { articles: final.articles, vision, plan: final.plan, quality: final.quality, lowQuality };
}
```

注意：`import` 语句挪到文件顶部与 Task 2 的 import 并列（ESM 不允许中段 import；实现时把这行合并到文件头）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/image-mine.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/image-mine.js agent/test/image-mine.test.js
git commit -m "feat(agent): 图片流水线纯编排层——四阶段 + 质量门重跑 + restyle 复用入口"
```

---

### Task 4: 生产包装层 makeStageCaller/mineImageOnly + 配置开关

**Files:**
- Modify: `agent/src/image-mine.js`（追加生产包装层）
- Modify: `agent/src/miner.js:60-79`（`loadModelConfig` 增加 `imagePipeline` 字段）
- Test: `agent/test/model-config.test.js`（追加 flag 用例）、`agent/test/image-mine.test.js`（追加 caller 用例）

**Interfaces:**
- Consumes: `writeLlmLog(env, entry)`（`agent/src/llmlog.js`）、`debit(env.USAGE, scope, cost, kind, meta, ts)`（`agent/src/usage_store.js`）、`claudeCostUY(model, in, out, cw, cr)`（`agent/src/usage.js`）、`runImagePipeline / buildFactPack`（Task 2/3）
- Produces:
  - `makeStageCaller(env, { modelCfg, scope, stem, turnId, log=()=>{} }) → callModel`（带 llmlog + 算力 debit 的生产 callModel）
  - `mineImageOnly(env, { scope, stem, photos, styleText, modelCfg, turnId, log=()=>{} }) → Promise<runImagePipeline 的返回>`
  - `loadModelConfig` 返回对象新增 `imagePipeline: boolean`

- [ ] **Step 1: 写失败测试**

`agent/test/model-config.test.js` 追加（文件已有 fakeEnv/loadModelConfig 的既有用例，模式照抄）：

```js
it("imagePipeline: config/model.json 里 true → true；缺省 → false", async () => {
  const on = fakeEnv({ "config/model.json": JSON.stringify({ providerKey: "anthropic", imagePipeline: true }) });
  on.CLAUDE_API_KEY = "k";
  expect((await loadModelConfig(on)).imagePipeline).toBe(true);

  const off = fakeEnv({ "config/model.json": JSON.stringify({ providerKey: "anthropic" }) });
  off.CLAUDE_API_KEY = "k";
  expect((await loadModelConfig(off)).imagePipeline).toBe(false);

  const noCfg = fakeEnv({});
  noCfg.CLAUDE_API_KEY = "k";
  expect((await loadModelConfig(noCfg)).imagePipeline).toBe(false);
});
```

`agent/test/image-mine.test.js` 追加：

```js
import { vi, afterEach } from "vitest";
import { makeStageCaller, mineImageOnly } from "../src/image-mine.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("makeStageCaller / mineImageOnly（生产包装）", () => {
  const CFG = { providerKey: "anthropic", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "k" };
  it("按阶段打 LLM 并写 llmlog（图片 base64 被脱敏）", async () => {
    const env = fakeEnv({});
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(CANNED.observe) }], usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => "" };
    });
    const cm = makeStageCaller(env, { modelCfg: CFG, scope: SCOPE, stem: "s", turnId: "t" });
    const raw = await cm({ stage: "observe", payload: buildObservePayload() });
    expect(JSON.parse(raw).images.length).toBe(1);
    expect(calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(true);
    // llmlog 落盘且 request 里的图片被 elide
    const logKeys = [...env.FILES._store.keys()].filter((k) => k.startsWith("llmlog/"));
    expect(logKeys.length).toBe(1);
    const entry = JSON.parse(env.FILES._store.get(logKeys[0]));
    expect(JSON.stringify(entry.request)).not.toContain("BASE64BASE64");
    expect(entry.meta.stage).toBe("observe");
  });
  it("LLM 非 200 → 抛错并写失败 llmlog", async () => {
    const env = fakeEnv({});
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }));
    const cm = makeStageCaller(env, { modelCfg: CFG, scope: SCOPE, stem: "s", turnId: "t" });
    await expect(cm({ stage: "plan", payload: { model: "m" } })).rejects.toThrow("500");
    const logKeys = [...env.FILES._store.keys()].filter((k) => k.startsWith("llmlog/"));
    expect(JSON.parse(env.FILES._store.get(logKeys[0])).ok).toBe(false);
  });
  it("mineImageOnly 端到端：4 次 LLM、返回 vision/plan/quality", async () => {
    const env = fakeEnv({});
    const seq = ["observe", "plan", "write", "review"];
    let n = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(CANNED[seq[n++]]) }], usage: {} }),
      text: async () => "",
    }));
    const r = await mineImageOnly(env, { scope: SCOPE, stem: "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai", photos: PHOTOS2, styleText: "s", modelCfg: CFG, turnId: "t" });
    expect(n).toBe(4);
    expect(r.articles[0].title).toBe("终稿题");
    expect(r.quality.overall).toBe(92);
  });
});
```

测试顶部需要一个 `buildObservePayload()` 小助手（放在该 describe 前）：

```js
import { buildStagePayload } from "../src/prompts/image-pipeline.js";
const buildObservePayload = () => buildStagePayload({
  stage: "observe", model: "m",
  photos: [{ b64: "BASE64BASE64", label: "10:10:10", relKey: REL }],
  factPack: FACTS2,
});
```

（llmlog 的 R2 前缀以 `agent/src/llmlog.js` 实际为准——实现前先读该文件确认 key 前缀与 `writeLlmLog` 参数名，测试断言对齐真实实现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/image-mine.test.js test/model-config.test.js`
Expected: FAIL（`makeStageCaller is not a function`；imagePipeline undefined）

- [ ] **Step 3: 写实现**

`agent/src/miner.js` `loadModelConfig` 两处返回都加字段：

```js
      return {
        providerKey,
        provider,
        model:   cfg.model   || MINE_MODEL_DEFAULT,
        baseUrl: cfg.baseUrl || "",
        apiKey,
        imagePipeline: cfg.imagePipeline === true,
      };
```

```js
  return { providerKey: "anthropic", provider: "anthropic", model: MINE_MODEL_DEFAULT, baseUrl: "", apiKey: env.CLAUDE_API_KEY || "", imagePipeline: false };
```

`agent/src/image-mine.js` 追加（import 合并到文件头）：

```js
// ── 生产包装层：fetch + llmlog + 算力 debit ─────────────────────────────────────

import { writeLlmLog } from "./llmlog.js";
import { claudeCostUY } from "./usage.js";
import { debit } from "./usage_store.js";

// 日志用请求副本：图片 base64 可达 MB 级，换成占位符（同 miner.redactReqForLog 的逻辑，
// 但那边未导出且互相 import 会成环，这里保留一份轻量实现）。
function redactPayloadForLog(payload) {
  const tag = (s) => `[base64 image · ~${Math.round((String(s).length * 3) / 4 / 1024)}KB elided]`;
  const req = { ...payload };
  if (Array.isArray(req.messages)) {
    req.messages = req.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      return { ...m, content: m.content.map((b) => {
        if (b && b.type === "image" && b.source && b.source.data) return { ...b, source: { ...b.source, data: tag(b.source.data) } };
        if (b && b.type === "image_url" && b.image_url && b.image_url.url) return { ...b, image_url: { ...b.image_url, url: tag(b.image_url.url) } };
        return b;
      }) };
    });
  }
  return req;
}

// 生产 callModel：provider 分发 + llmlog + 算力 debit，每阶段一次调用一条日志一笔账。
export function makeStageCaller(env, { modelCfg, scope, stem, turnId, log = () => {} }) {
  return async ({ stage, payload }) => {
    const meta = { user_scope: scope, stem, stage, source: "image-pipeline" };
    const t0 = Date.now();
    try {
      let text, rawResp;
      if (modelCfg.provider === "openai-compat") {
        const resp = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${modelCfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        rawResp = await resp.json();
        text = rawResp.choices?.[0]?.message?.content || "";
      } else {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": modelCfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        rawResp = await resp.json();
        text = (rawResp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      }
      const latency = Date.now() - t0;
      await writeLlmLog(env, { ts: t0, source: "mine", ok: true, status: 200, model: modelCfg.model, latency_ms: latency, step: stage, turn_id: turnId, meta, request: redactPayloadForLog(payload), response: rawResp });
      try {
        if (env.USAGE) {
          const u = rawResp?.usage || {};
          await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
            "mine", { model: modelCfg.model, stage, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId }, Date.now());
        }
      } catch (_) {}
      log(`阶段完成:${stage}`, { latency_ms: latency });
      return text;
    } catch (e) {
      await writeLlmLog(env, { ts: t0, source: "mine", ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now() - t0, step: stage, turn_id: turnId, meta, error: String(e) });
      throw e;
    }
  };
}

// 生产入口：素材 → 流水线。任何异常向上抛，miner.js 捕获后回退现行单发。
export async function mineImageOnly(env, { scope, stem, photos, styleText, modelCfg, turnId, log = () => {} }) {
  const factPack = await buildFactPack(env, { scope, stem, photos });
  log("流水线开始", { photos: photos.length, place: factPack.place, titles: factPack.recentTitles.length });
  const callModel = makeStageCaller(env, { modelCfg, scope, stem, turnId, log });
  return await runImagePipeline({ photos, factPack, styleText, provider: modelCfg.provider, model: modelCfg.model, callModel, log });
}
```

（实现时先读 `agent/src/llmlog.js` 确认 `writeLlmLog` 的字段与 R2 key 前缀，若与上述断言不符，以真实实现为准调整测试。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/image-mine.test.js test/model-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/image-mine.js agent/src/miner.js agent/test/image-mine.test.js agent/test/model-config.test.js
git commit -m "feat(agent): 流水线生产包装层（llmlog+算力）与 modelCfg.imagePipeline 开关"
```

---

### Task 5: miner.js image-only 分支集成（开关 + 回退 + doc 字段）

**Files:**
- Modify: `agent/src/miner.js`（顶部 import + 约 line 1046–1087 的无语音分支）
- Test: `agent/test/mine-image.test.js`（追加流水线 describe；既有用例必须原样全绿）

**Interfaces:**
- Consumes: `mineImageOnly`（Task 4）、既有 `mineVariant / gatherPhotos / writeArticle / notifyStatus / maybeAutoShareCommunity`
- Produces: 流水线成功时 article doc 增量字段 `vision / plan / quality`；`modelCfg.imagePipeline` 为 false 或流水线失败时行为与现行完全一致

- [ ] **Step 1: 写失败测试**

`agent/test/mine-image.test.js` 追加（复用文件里已有的 envWithPhotos/SCOPE/STEM/AUDIO/PHOTO_REL/PHOTO_KEY/MODEL_CFG）：

```js
const CFG_PIPE = { ...MODEL_CFG, imagePipeline: true };
const REL2 = PHOTO_REL;
const PIPE_CANNED = {
  observe: { images: [{ key: REL2, caption: "拿铁", confidence: 0.9 }], timeline: "", clusters: [], repeated_entities: [] },
  plan: { candidates: [], selected: "A", rejected_because: "", thesis: "t", title_options: [], sections: [], image_role_map: {} },
  write: { articles: [{ title: "初稿", body: `x\n\n[[photo:${REL2}]]` }] },
  review: { articles: [{ title: "流水线终稿", body: `y\n\n[[photo:${REL2}]]` }], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] },
};
// anthropic 依调用次序回放 observe→plan→write→review；其余路由同 makeFetch。
function makePipelineFetch({ failFirstLlm = false } = {}) {
  const calls = []; const seq = ["observe", "plan", "write", "review"]; let llmN = 0;
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
    const withHeader = (code, body) => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "x-api-status-code" ? code : "logid") }, json: async () => body, text: async () => JSON.stringify(body ?? {}) });
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/submit")) return withHeader("20000000", {});
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/query")) return withHeader("20000000", { result: { text: "", utterances: [] }, audio_info: { duration: 1000 } });
    if (u.includes("api.anthropic.com")) {
      llmN++;
      if (failFirstLlm && llmN === 1) return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      // 流水线失败回退后的单发也会走到这里：回退调用给单发文章
      const stage = seq[llmN - (failFirstLlm ? 2 : 1)];
      const body = stage ? PIPE_CANNED[stage] : { articles: [{ title: "单发回退", body: `z\n\n[[photo:${REL2}]]` }] };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(body) }], usage: {} }), text: async () => "" };
    }
    if (u.includes("/files/api/")) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
  };
  fn.calls = calls;
  return fn;
}

describe("mineOneAudio: imagePipeline 开关", () => {
  it("开关开：走四阶段流水线，doc 带 vision/plan/quality，文章来自终审稿", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makePipelineFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, CFG_PIPE);
    expect(r).toBe("mined");
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(4);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(put.body);
    expect(doc.articles[0].title).toBe("流水线终稿");
    expect(doc.vision.images[0].key).toBe(REL2);
    expect(doc.plan.thesis).toBe("t");
    expect(doc.quality.overall).toBe(90);
  });
  it("开关开但流水线首调失败：回退单发，doc 无 vision，文章照写", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makePipelineFetch({ failFirstLlm: true });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, CFG_PIPE);
    expect(r).toBe("mined");
    // 1 次失败的 observe + 1 次回退单发 = 2 次 LLM
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(2);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(put.body);
    expect(doc.articles[0].title).toBe("单发回退");
    expect(doc.vision).toBeUndefined();
  });
  it("开关关：行为与现行一致（1 次单发调用，doc 无 vision）", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makeFetch({ transcriptText: "", articles: [{ title: "旧路径", body: `w\n\n[[photo:${REL2}]]` }] });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(1);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(JSON.parse(put.body).vision).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/mine-image.test.js`
Expected: 新增 3 例 FAIL（现行分支不认识 imagePipeline），既有用例 PASS

- [ ] **Step 3: 写实现**

`agent/src/miner.js` 顶部 import 区追加：

```js
import { mineImageOnly } from "./image-mine.js";
```

无语音分支（现 line ~1050–1079）改为：

```js
      const photos = await gatherPhotos(audioKey, allKeys, env, log);
      if (photos.length) {
        log("无语音但有照片,改走看图模式", { count: photos.length, pipeline: !!modelCfg.imagePipeline });
        await notifyStatus(scope, stem, "mining", env);
        // 和正常语音挖矿一样：文风文本进 prompt，articles[i].style 打 head 版本号
        //（不打的话 iOS chip 显示「选风格」，看起来像没用文风）。
        const imgStyleDoc = await readStyleDoc(env, scope + "CLAUDE.json");
        const styleText = (imgStyleDoc ? resolveStyle(imgStyleDoc) : await readStyleText(env, scope + "CLAUDE.json", scope + "CLAUDE.md")).trim();
        const imgHeadV = imgStyleDoc && Number.isInteger(imgStyleDoc.head) ? imgStyleDoc.head : null;
        const turnId = `${Date.now()}-${stem.slice(-8)}`;

        // 流水线（modelCfg.imagePipeline，缺省关）：观察→立意→写作→审稿。
        // 任何失败回退下方现行单发 —— 质量下限就是今天的行为。
        let arts = [], pipe = null;
        if (modelCfg.imagePipeline) {
          try {
            pipe = await mineImageOnly(env, { scope, stem, photos, styleText, modelCfg, turnId, log });
            arts = pipe.articles;
            if (pipe.lowQuality) log("流水线质量门未过,交付较高一版", { overall: pipe.quality && pipe.quality.overall });
          } catch (e) {
            pipe = null;
            log("流水线失败,回退单发", { error: String((e && e.message) || e).slice(0, 200) });
          }
        }
        if (!arts.length) {
          pipe = null;
          arts = await mineVariant(env, {
            transcript: "", styleText, photos, cacheMode: "system", modelCfg, scope, stem, turnId,
            systemOverride: IMAGE_ONLY_SYSTEM, noForce: true, photoInstr: "",
            metaExtra: { source: "image" }, log,
          });
        }
        if (arts.length) {
          const doc = {
            schema: 2, id: stem, sourceAudio: leaf,
            createdAt: uploaded[audioKey] || new Date().toISOString(),
            transcript: "", srt: "",
            articles: imgHeadV ? arts.map((a) => ({ ...a, style: imgHeadV })) : arts,
            status: "ready", model: modelCfg.model,
            ...(pipe ? { vision: pipe.vision, plan: pipe.plan, quality: pipe.quality } : {}),
          };
          await writeArticle(audioKey, doc, env);
          await notifyStatus(scope, stem, "ready", env);
          try { await maybeAutoShareCommunity(audioKey, env, log); } catch (e) { log("自动分享失败", { error: String(e) }); }
          log("看图写入完成", { articles: arts.length, pipeline: !!pipe });
          result = "mined";
          return "mined";
        }
        log("看图也没写出内容,回退无语音");
      }
```

- [ ] **Step 4: 跑测试确认通过（含既有用例回归）**

Run: `cd agent && npx vitest run test/mine-image.test.js`
Expected: 全绿（新增 3 + 既有 8）

- [ ] **Step 5: Commit**

```bash
git add agent/src/miner.js agent/test/mine-image.test.js
git commit -m "feat(agent): image-only 挖矿接入四阶段流水线（开关+回退+doc.vision/plan/quality）"
```

---

### Task 6: restyle 复用观察结果（换文风不重新看图）

**Files:**
- Modify: `agent/src/miner.js`（`restyleArticle`，现 line ~778–819）
- Test: `agent/test/remine-style-version.test.js`（追加用例；先读该文件照抄其 env/fetch 模式）

**Interfaces:**
- Consumes: `rewriteFromVision / buildFactPack / makeStageCaller`（Task 3/4）、`doc.vision / doc.plan`（Task 5 写入）
- Produces: `restyleArticle` 在 `modelCfg.imagePipeline && !transcript && doc.vision && doc.plan && photos.length` 时只跑 write+review 两次 LLM；其余场景走既有 `mineVariant` 路径不变

- [ ] **Step 1: 写失败测试**

先 `Read agent/test/remine-style-version.test.js` 摸清既有 restyle 测试的 env 种子（文风 doc、article doc、照片 key）与 fetch 假件模式，然后追加：

```js
it("图片流水线产物 restyle：doc.vision/plan 在 → 只打 2 次 LLM（write+review），不重跑观察", async () => {
  // env 种子：article doc 带 vision/plan、transcript=""；CLAUDE.json 带两个文风版本；session 照片在 R2。
  // fetch 假件：anthropic 依次回放 write→review 的 canned JSON；断言 anthropic 调用数 === 2，
  // 且第 1 个 payload 的 system 含 <style> 与目标文风文本、不含图片；第 2 个含图片。
  // 结果断言：restyleArticle 返回 ok:true，新 head 文章 title 来自 review 稿，style 字段 = 目标版本号。
});
```

（具体种子代码在实现时按该文件既有 helper 展开——测试文件里已有完整的 restyle 环境构造，复制最近一个用例改造；canned JSON 用 Task 5 的 `PIPE_CANNED.write/review`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/remine-style-version.test.js`
Expected: 新用例 FAIL（现行 restyle 走 mineVariant 单发，LLM 调用数不是 2 或 payload 无 write 阶段特征）

- [ ] **Step 3: 写实现**

`agent/src/miner.js` `restyleArticle`：在拿到 `modelCfg`、`turnId` 之后、调用 `mineVariant` 之前插入：

```js
  // 图片流水线产物（无转写、doc.vision/plan 在）→ 复用观察与立意，只重跑写作+审稿。
  // 换文风不换立意；照片只在审稿阶段重新入场核对误读。失败静默落回下方 mineVariant。
  let articles = null;
  if (modelCfg.imagePipeline && !transcript && doc.vision && doc.plan && photos.length) {
    try {
      const factPack = await buildFactPack(env, { scope, stem, photos });
      const callModel = makeStageCaller(env, { modelCfg, scope, stem, turnId });
      const r = await rewriteFromVision({
        photos, factPack, vision: doc.vision, plan: doc.plan, styleText,
        provider: modelCfg.provider, model: modelCfg.model, callModel,
      });
      if (r.articles.length) articles = r.articles;
    } catch (_) { articles = null; }
  }
  if (!articles) {
    articles = await mineVariant(env, {
      transcript: mineSource, styleText, photos, cacheMode: "transcript", modelCfg, scope, stem, turnId,
      metaExtra: { restyle: v }, debitExtra: { restyle: v },
    });
  }
```

（原来的 `const articles = await mineVariant(...)` 整段被上面替换；后续 `if (!articles.length) return ...; const tagged = ...` 保持不变。miner.js 顶部 import 追加 `buildFactPack, makeStageCaller, rewriteFromVision`——与 Task 5 的 `mineImageOnly` 合并成一行 import。）

- [ ] **Step 4: 跑测试确认通过（含既有 restyle 用例回归）**

Run: `cd agent && npx vitest run test/remine-style-version.test.js`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add agent/src/miner.js agent/test/remine-style-version.test.js
git commit -m "feat(agent): restyle 复用图片流水线观察结果——换文风只重跑写作+审稿"
```

---

### Task 7: eval 扩展——champion(单发) vs candidate(流水线)

**Files:**
- Create: `agent/eval/lib/image-proxy-checks.mjs`
- Create: `agent/eval/run-image-eval.mjs`
- Create: `agent/eval/fixtures/image-samples/sample-1.json`
- Modify: `agent/eval/README.md`（追加 image eval 一节）
- Test: `agent/test/eval-image.test.js`

**Interfaces:**
- Consumes: `buildMinePrompt / parseArticles / MINE_MODEL_DEFAULT`（miner.js 已导出）、`IMAGE_ONLY_SYSTEM`（prompts/mine.js）、`runImagePipeline / parsePlaceTag / parseSessionInfo`（image-mine.js）
- Produces:
  - `runImageProxyChecks(articles, { photoKeys }) → { pass, failures[] }`
  - `loadImageFixtures(baseDir?) → fixture[]`（`fixtures/image-local/` 优先，回退 `fixtures/image-samples/`；fixture 结构 `{ id, stem, photos:[{b64,label,relKey}], styleText?, recentTitles?[] }`）
  - `runImageEval({ fixtures, callModel, model }) → { results: [{ fixtureId, champion, candidate }] }`（两侧都带 `.articles` 与 `.proxy`）
  - CLI：`node eval/run-image-eval.mjs <runId>`（需 `CLAUDE_API_KEY`），产出 `eval/runs/<runId>/`

- [ ] **Step 1: 写失败测试**

`agent/test/eval-image.test.js`：

```js
// image eval：proxy checks 的确定性判定 + runImageEval 的 champion/candidate 双跑。
import { describe, it, expect } from "vitest";
import { runImageProxyChecks } from "../eval/lib/image-proxy-checks.mjs";
import { runImageEval, loadImageFixtures } from "../eval/run-image-eval.mjs";

const K = "photos/2026-07-01-101010/0-x.jpg";

describe("runImageProxyChecks", () => {
  it("每图恰好一次且独占一行 → pass", () => {
    const r = runImageProxyChecks([{ title: "t", body: `a\n\n[[photo:${K}]]\n\nb` }], { photoKeys: [K] });
    expect(r.pass).toBe(true);
  });
  it("漏图 / 重复 / 发明 key / 非独行 → 对应 failure", () => {
    expect(runImageProxyChecks([{ title: "t", body: "无图" }], { photoKeys: [K] }).failures).toContain(`missing-photo:${K}`);
    expect(runImageProxyChecks([{ title: "t", body: `[[photo:${K}]]\n[[photo:${K}]]` }], { photoKeys: [K] }).failures).toContain(`dup-photo:${K}`);
    expect(runImageProxyChecks([{ title: "t", body: `[[photo:ghost.jpg]]\n\n[[photo:${K}]]` }], { photoKeys: [K] }).failures).toContain("invented-photo:ghost.jpg");
    expect(runImageProxyChecks([{ title: "t", body: `文字[[photo:${K}]]同行` }], { photoKeys: [K] }).failures).toContain("marker-not-own-line");
    expect(runImageProxyChecks([], { photoKeys: [K] }).failures).toContain("no-article");
  });
});

describe("runImageEval", () => {
  const FX = [{ id: "fx1", stem: "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai", photos: [{ b64: "AA", label: "10:10:10", relKey: K }], styleText: "" }];
  const CANNED = {
    single: { articles: [{ title: "单发", body: `s\n\n[[photo:${K}]]` }] },
    observe: { images: [{ key: K, caption: "c", confidence: 0.9 }], timeline: "", clusters: [], repeated_entities: [] },
    plan: { candidates: [], selected: "A", rejected_because: "", thesis: "t", title_options: [], sections: [], image_role_map: {} },
    write: { articles: [{ title: "初稿", body: `w\n\n[[photo:${K}]]` }] },
    review: { articles: [{ title: "流水线", body: `r\n\n[[photo:${K}]]` }], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] },
  };
  it("champion 走 IMAGE_ONLY 单发、candidate 走四阶段，各自带 proxy", async () => {
    const stages = [];
    const callModel = async ({ stage }) => { stages.push(stage); return JSON.stringify(CANNED[stage]); };
    const { results } = await runImageEval({ fixtures: FX, callModel, model: "m" });
    expect(stages).toEqual(["single", "observe", "plan", "write", "review"]);
    expect(results[0].champion.articles[0].title).toBe("单发");
    expect(results[0].candidate.articles[0].title).toBe("流水线");
    expect(results[0].champion.proxy.pass).toBe(true);
    expect(results[0].candidate.proxy.pass).toBe(true);
  });
  it("candidate 某阶段抛错 → candidate.error 记录且不影响 champion", async () => {
    const callModel = async ({ stage }) => { if (stage === "plan") throw new Error("boom"); return JSON.stringify(CANNED[stage] || CANNED.single); };
    const { results } = await runImageEval({ fixtures: FX, callModel, model: "m" });
    expect(results[0].champion.articles.length).toBe(1);
    expect(results[0].candidate.error).toContain("boom");
    expect(results[0].candidate.proxy.pass).toBe(false);
  });
});

describe("loadImageFixtures", () => {
  it("samples 目录可加载且结构齐全", () => {
    const fx = loadImageFixtures();
    expect(fx.length).toBeGreaterThan(0);
    expect(fx[0]).toHaveProperty("id");
    expect(fx[0].photos[0]).toHaveProperty("b64");
    expect(fx[0].photos[0]).toHaveProperty("relKey");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/eval-image.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`agent/eval/lib/image-proxy-checks.mjs`：

```js
// image-only 产物的确定性回退检查（不打 LLM）：photo 标记完整性与格式。
// 语义质量（信息密度/立意/文风）交给 judge 盲评，这里只拦「结构性坏」。
export function runImageProxyChecks(articles, { photoKeys = [] } = {}) {
  const failures = [];
  const arts = Array.isArray(articles) ? articles : [];
  if (!arts.length) failures.push("no-article");
  const body = arts.map((a) => a.body || "").join("\n\n");
  const found = [...body.matchAll(/\[\[photo:([^\]]+)\]\]/g)].map((m) => m[1]);
  for (const k of photoKeys) {
    const n = found.filter((f) => f === k).length;
    if (n === 0) failures.push(`missing-photo:${k}`);
    if (n > 1) failures.push(`dup-photo:${k}`);
  }
  for (const f of found) if (!photoKeys.includes(f)) failures.push(`invented-photo:${f}`);
  for (const a of arts) {
    for (const line of (a.body || "").split("\n")) {
      const t = line.trim();
      if (t.includes("[[photo:") && !/^\[\[photo:[^\]]+\]\]$/.test(t)) { failures.push("marker-not-own-line"); break; }
    }
  }
  return { pass: failures.length === 0, failures };
}
```

`agent/eval/run-image-eval.mjs`：

```js
// image-only 挖矿 eval：champion = 现行 IMAGE_ONLY_SYSTEM 单发；candidate = 四阶段流水线。
// fixture 结构：{ id, stem, photos:[{b64,label,relKey}], styleText?, recentTitles?[] }
// 真实金标放 eval/fixtures/image-local/（gitignore，私人照片数据）；合成样例在 image-samples/。
// 用法：CLAUDE_API_KEY=… node eval/run-image-eval.mjs <runId>
// 判定：proxy 全过之后，用 /wjs-evaling-voicedrop-prompts 的盲评流程对 outputs 打分。
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMinePrompt, parseArticles, MINE_MODEL_DEFAULT } from "../src/miner.js";
import { IMAGE_ONLY_SYSTEM } from "../src/prompts/mine.js";
import { runImagePipeline, parsePlaceTag, parseSessionInfo } from "../src/image-mine.js";
import { runImageProxyChecks } from "./lib/image-proxy-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadImageFixtures(baseDir = join(HERE, "fixtures")) {
  const local = join(baseDir, "image-local");
  const dir = (existsSync(local) && readdirSync(local).some((f) => f.endsWith(".json")))
    ? local : join(baseDir, "image-samples");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function runImageEval({ fixtures, callModel, model }) {
  const results = [];
  for (const fx of fixtures) {
    const photoKeys = fx.photos.map((p) => p.relKey);
    const factPack = {
      place: parsePlaceTag(fx.stem),
      session: parseSessionInfo(fx.stem),
      photos: fx.photos.map((p) => ({ key: p.relKey, time: p.label })),
      recentTitles: fx.recentTitles || [],
    };
    // champion：与生产 mineVariant 的 image-only 调用同参（single 一发）
    const champion = { articles: [] };
    try {
      const payload = buildMinePrompt({
        transcript: "", styleText: fx.styleText || "", photos: fx.photos, force: false,
        provider: "anthropic", model, systemPrompt: IMAGE_ONLY_SYSTEM, photoInstr: "",
      });
      champion.articles = parseArticles(await callModel({ stage: "single", payload }));
    } catch (e) { champion.error = String(e); }
    // candidate：四阶段流水线
    let candidate = { articles: [] };
    try {
      candidate = await runImagePipeline({
        photos: fx.photos, factPack, styleText: fx.styleText || "", model, callModel,
      });
    } catch (e) { candidate = { articles: [], error: String(e) }; }
    results.push({
      fixtureId: fx.id,
      champion: { ...champion, proxy: runImageProxyChecks(champion.articles, { photoKeys }) },
      candidate: { ...candidate, proxy: runImageProxyChecks(candidate.articles, { photoKeys }) },
    });
  }
  return { results };
}

async function anthropicCallModel({ payload }) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺 CLAUDE_API_KEY 环境变量");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runId = process.argv[2] || "image-run-local";
  const fixtures = loadImageFixtures();
  const { results } = await runImageEval({ fixtures, callModel: anthropicCallModel, model: MINE_MODEL_DEFAULT });
  const outDir = join(HERE, "runs", runId);
  mkdirSync(join(outDir, "outputs"), { recursive: true });
  for (const r of results) {
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.champion.json`), JSON.stringify(r.champion, null, 2));
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.candidate.json`), JSON.stringify(r.candidate, null, 2));
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`✓ ${results.length} 条 image fixture 已跑完，产出在 eval/runs/${runId}/`);
  const proxyFails = results.filter((r) => !r.candidate.proxy.pass).map((r) => r.fixtureId);
  if (proxyFails.length) console.log(`⚠️ 候选侧确定性回退: ${proxyFails.join(", ")}`);
}
```

`agent/eval/fixtures/image-samples/sample-1.json` —— 用真实可解码的 1×1 JPEG（生成命令）：

```bash
python3 - <<'EOF'
import base64, json
# 最小合法 JPEG（1x1 白点）——喂给真实 API 也能通过图片解码
jpg = base64.b64decode(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==")
fx = {
  "id": "sample-1",
  "stem": "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai-Xuhui",
  "photos": [{"b64": base64.b64encode(jpg).decode(), "label": "10:10:10",
               "relKey": "photos/2026-07-01-101010/0-sample.jpg"}],
  "styleText": "",
  "recentTitles": ["上一篇文章的标题"],
}
open("eval/fixtures/image-samples/sample-1.json", "w").write(json.dumps(fx, ensure_ascii=False, indent=2))
EOF
```

`agent/eval/README.md` 追加一节：

```markdown
## 图片生文（image-only）eval

- 入口：`CLAUDE_API_KEY=… node eval/run-image-eval.mjs <runId>`
- champion = 现行 `IMAGE_ONLY_SYSTEM` 单发；candidate = 观察→立意→写作→审稿四阶段流水线
- 金标 fixture 放 `fixtures/image-local/*.json`（gitignore，真实照片）；结构见 `fixtures/image-samples/sample-1.json`
- 确定性检查（photo 标记完整性）在 `lib/image-proxy-checks.mjs`；语义质量用 `/wjs-evaling-voicedrop-prompts` 盲评 outputs
- 通过标准（spec §6）：candidate 胜率 ≥ 60% 且编造项零回归 → 把 `config/model.json` 的 `imagePipeline` 置 true
```

（若 `fixtures/local` 的 gitignore 规则不自动覆盖 `image-local`，在 `agent/eval/fixtures/.gitignore` 或仓库 `.gitignore` 里补一行 `image-local/`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/eval-image.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/eval/lib/image-proxy-checks.mjs agent/eval/run-image-eval.mjs agent/eval/fixtures/image-samples/sample-1.json agent/eval/README.md agent/test/eval-image.test.js
git commit -m "feat(eval): image-only 单发 vs 流水线对比 eval 入口与确定性检查"
```

---

### Task 8: 全量回归 + 交付

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md`（状态行改「已实现，待 eval 开闸」）

- [ ] **Step 1: 全量测试**

Run: `cd agent && npx vitest run`
Expected: 全部测试文件 PASS（尤其既有 mine-image / remine-style-version / model-config / eval-run 零回归）

- [ ] **Step 2: 冒烟检查 Worker 打包**

Run: `cd agent && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry 2>&1 | tail -5`
Expected: 打包成功无 import 错误（不真正部署）

- [ ] **Step 3: 更新 spec 状态并提交**

```bash
git add -A
git commit -m "docs: spec 状态更新——流水线已实现，待金标 eval 开闸"
```

- [ ] **Step 4: 推分支 + 开 draft PR**

```bash
git push -u origin worktree-image-mine-pipeline
gh pr create --draft --title "图片生文 image-only 挖矿多遍流水线（默认关，eval 开闸）" --body "..."
```

---

## Self-Review 结果

- **Spec coverage**：Stage 0（Task 2）、Stage 1–4 与质量门（Task 1/3）、开关与回退（Task 4/5）、doc 字段与 restyle 复用（Task 5/6）、eval（Task 7）、「有语音路径零改动」（Task 5 只改无语音分支 + 全量回归）——spec §4–§6 全覆盖；§7 成本无代码项；§9 二期不在本计划。
- **Placeholder**：Task 6 Step 1 的测试骨架依赖先读既有 remine-style-version.test.js 的环境构造（该文件是现成真源，实现时照抄改造），其余任务代码完整。
- **Type consistency**：`callModel({stage,payload})→string`、`FactPack{place,session,photos,recentTitles}`、`rewriteFromVision→{articles,quality,issues}`、`runImagePipeline→{articles,vision,plan,quality,lowQuality}` 在 Task 1/2/3/4/5/6/7 间一致；`modelCfg.imagePipeline` 命名全程一致。
