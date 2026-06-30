# VoiceDrop Prompt 评估系统（wjs-evaling-voicedrop-prompts）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 VoiceDrop 挖矿 system prompt 从代码里抽成独立可版本化的文件，并建一套本地（开发机 Claude Code）跑的 eval harness，对「候选版 vs 当前生产版」做同输入成对盲评。

**Architecture:** 两层。版本层——挖矿 prompt 文本移到 `agent/src/prompts/mine.js`，生产代码 import，git 即版本库。效果层——从 `generateArticles` 抽出纯函数 `buildMinePrompt`（生产 + harness 共用，保证 prompt 字节一致），harness 脚本住 `agent/eval/`（跑批 + 确定性检查 + 聚合），skill 住 `~/.claude/skills/`（判分 rubric + 编排协议）。裁判是 Claude Code dispatch 出的 subagent。

**Tech Stack:** Node ESM、vitest（`npm test` → `vitest run`）、Cloudflare Workers（wrangler）、Anthropic Messages API、`test/fakes.js` 的 `fakeEnv`/`fakeFetch`。

## Global Constraints

- **不改变线上挖矿行为**：Task 1/2 是纯重构，重构前后对同一输入产出的 payload 必须字节一致（验收标准 #1）。
- **prompt 保真**：生产 `generateArticles` 与 harness `run-eval.mjs` 必须 import 同一个 `buildMinePrompt` 与同一份 `agent/src/prompts/mine.js`，禁止在 harness 里另写 prompt 文本。
- **eval 不计费、不写线上日志**：harness 的模型调用走自己的极简 fetch，**不**调用 `debit` / `writeLlmLog`。
- **挖矿模型**：默认 `claude-opus-4-8`（`MINE_MODEL_DEFAULT`，`miner.js:21`）；`cacheMode` 默认 `"system"`、`provider` 默认 `"anthropic"`。
- **裁判模型与生成模型不同家族**（缓解自我偏好）；成对盲评 A/B 顺序随机；忠实不编造为一票否决维度。
- **判定阈值**：候选胜率 ≥ 0.70 且无确定性回退且人工认可 → 才晋级。
- **ESM only**（`agent/package.json` 有 `"type": "module"`）；测试文件放 `agent/test/*.test.js`，`import ... from "../src/..."`。
- **v1 只做挖矿 prompt**（`MINE_SYSTEM` + `MINE_SYSTEM_FORCE`）；审核 / 语音编辑 prompt 不在范围内。
- **🔒 数据隐私（硬约束）**：`jianshuo/jianshuo.dev` 是 **PUBLIC** 仓库。真实录音转写与跑批产出是私人数据，**绝不 commit**。git 只收：合成/脱敏的种子 fixture（`fixtures/samples/`）+ README + 代码。真实金标集放 `fixtures/local/`（gitignore），跑批产物 `runs/`（gitignore）。harness 全程不碰 mp3——只需文本转写（VoiceDrop 已转写）。真实 fixture 的权威备份在 VoiceDrop / R2（私有），本地只是可重拉的快照。

---

## File Structure

```
agent/src/prompts/mine.js          # 新：导出 MINE_SYSTEM / MINE_SYSTEM_FORCE / PHOTO_INSTR / MINE_DEFAULT_STYLE
agent/src/miner.js                 # 改：import 上面 4 个常量；抽出并 export buildMinePrompt；export parseArticles；generateArticles 改调 buildMinePrompt
agent/eval/fixtures/README.md      # 提交：格式约定 + 真实数据补充流程
agent/eval/fixtures/samples/*.json # 提交：仅合成/脱敏种子（self-test 用）
agent/eval/fixtures/local/         # ⛔ gitignore：真实录音转写（私人数据，绝不进公开 repo）
agent/eval/lib/proxy-checks.mjs    # 新：纯函数 runProxyChecks(articles,{transcript})
agent/eval/lib/aggregate.mjs       # 新：纯函数 aggregate(verdicts,{threshold,proxyFails})
agent/eval/run-eval.mjs            # 新：编排——fixtures × 两版 → 调模型 → 产出 + 检查 → 落 runs/
agent/eval/runs/                   # ⛔ gitignore：跑批产物（产出衍生自真实转写，含私人内容）
agent/test/build-mine-prompt.test.js   # 新：buildMinePrompt 单测
agent/test/eval-proxy-checks.test.js   # 新：runProxyChecks 单测
agent/test/eval-aggregate.test.js      # 新：aggregate 单测
agent/test/eval-run.test.js            # 新：runEval 编排单测（注入 fake callModel）

~/.claude/skills/wjs-evaling-voicedrop-prompts/
├── SKILL.md                       # 新：触发词 + 编排协议 + 判定/晋级流程
└── references/judge-rubric.md     # 新：裁判 subagent 的固定 rubric（5 维度 + 输出 schema）
```

---

### Task 1: 挖矿 prompt 文本外置到 `agent/src/prompts/mine.js`

把 `miner.js:88–123` 的四个 prompt 常量原样搬进独立模块，`miner.js` 改为 import。纯重构，行为零变化。

**Files:**
- Create: `agent/src/prompts/mine.js`
- Modify: `agent/src/miner.js:86-123`（删 4 个 const，加一行 import）
- Test: 复用现有全套（`agent/test/*`），外加一个对照断言

**Interfaces:**
- Produces: 模块 `agent/src/prompts/mine.js` 导出 `MINE_SYSTEM`、`MINE_SYSTEM_FORCE`、`PHOTO_INSTR`、`MINE_DEFAULT_STYLE`（均为 string，逐字符等于现 `SYSTEM`/`SYSTEM_FORCE`/`_PHOTO_INSTR`/`DEFAULT_STYLE`）。

- [ ] **Step 1: 写对照测试（先失败）**

Create `agent/test/prompt-extraction.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { MINE_SYSTEM, MINE_SYSTEM_FORCE, PHOTO_INSTR, MINE_DEFAULT_STYLE } from "../src/prompts/mine.js";

describe("prompts/mine.js 文本外置", () => {
  it("MINE_SYSTEM 开头不变", () => {
    expect(MINE_SYSTEM.startsWith("你是这段录音的录制者，在写自己的公众号文章。")).toBe(true);
    expect(MINE_SYSTEM).toContain("只用转写里出现的事实，绝不编造、不脑补");
    expect(MINE_SYSTEM).toContain('{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}');
  });
  it("MINE_SYSTEM_FORCE 不变", () => {
    expect(MINE_SYSTEM_FORCE.startsWith("把下面的口述转写整理成一篇短文")).toBe(true);
  });
  it("PHOTO_INSTR 含照片标记说明", () => {
    expect(PHOTO_INSTR).toContain("[[photo:<key>]]");
  });
  it("MINE_DEFAULT_STYLE 含王建硕语气 DNA", () => {
    expect(MINE_DEFAULT_STYLE).toContain("胸有成竹");
    expect(MINE_DEFAULT_STYLE).toContain("绝不用「笔者」");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/prompt-extraction.test.js`
Expected: FAIL — `Failed to resolve import "../src/prompts/mine.js"`

- [ ] **Step 3: 建 `agent/src/prompts/mine.js`**

把 `miner.js` 现有四个常量的**字面值逐字符照搬**（`miner.js:88` 的 `_PHOTO_INSTR`、`:95` 的 `SYSTEM`、`:115` 的 `DEFAULT_STYLE`、`:123` 的 `SYSTEM_FORCE`），改成导出，重命名如下：

```javascript
// VoiceDrop 挖矿 system prompt —— 版本层单一真源。
// 生产（agent/src/miner.js 的 buildMinePrompt）与 eval harness（agent/eval/run-eval.mjs）
// 都 import 这里，保证 prompt 字节一致。git diff 本文件 = prompt 版本对比。

export const PHOTO_INSTR = `
另外附上了几张照片，每张图片前都有一行 \`<photo key="…" time="…">\` 标签（图片后是 \`</photo>\`），标了它的 key 和拍摄时刻。照片是作者一边说一边拍的，拍摄时刻能帮你判断这张照片对应口述里的哪一段。要求：
- 把照片的场景自然融进叙述，就像亲眼看到一样直接写进去，不要机械地写「照片里是…」。
- 在正文里、口述提到这个场景的那个位置，单独起一行插入照片标记 \`[[photo:<key>]]\`（<key> 原样填我给你的那张照片的 key）。标记必须独占一行，前后空行。
- 每张照片在全文里只插入一次，按拍摄时刻对应到合适的段落附近。
- 如果某张照片实在和口述对不上，就放在最相关的那段后面。`;

export const MINE_SYSTEM = `你是这段录音的录制者，在写自己的公众号文章。下面 <transcript> 标签里是你自己的口述录音转写。把它挖成一篇或多篇可以各自独立发布的公众号文章。

拆分规则（重要）：
- 默认尽量合并。只有当转写里明显包含几个互不相关的主题时，才拆成多篇。
- 倾向「少而厚」：宁可一篇讲透，也不要拆成几篇互相重复的碎片。
- 一段口述大多只产出 1 篇；只有真的跳了好几个不相干的话题，才产出 2–3 篇。
- 每一篇都必须能独立成立：有自己的标题、自己的开头结尾，不依赖其它篇。

【硬底线 — 任何风格都不可违反】
- 只用转写里出现的事实，绝不编造、不脑补。不提任何公司具体名字，需要时用「我们公司」。
- 篇幅完全顺着内容走：转写里有多少东西就写多少，长就长、短就短，三五句话也能成篇——绝不为凑字数注水，也不设字数下限或上限。
- 中英文之间留一个空格（盘古之白）。

具体「怎么写」（语气、句式、用词）见 <style> 标签里给出的风格说明；风格只决定怎么写，不改变以上硬底线。

只输出一个 JSON 对象：{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}，不要输出任何其它文字。只要转写里有哪怕一两句有意义的话，就要成文（可以很短）；只有完全没有可写内容时（纯噪音、半句没说完、纯口误）才输出 {"articles": []}。`;

export const MINE_DEFAULT_STYLE = `胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
细节能列就用表格 / 列表，不在叙述句里堆细节。
保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。`;

export const MINE_SYSTEM_FORCE = `把下面的口述转写整理成一篇短文，保留说话人的意思和语气。直接输出 JSON：{"articles": [{"title": "标题", "body": "正文"}]}。只要有人在说话就必须成文，不能返回空数组。`;
```

- [ ] **Step 4: 改 `miner.js` 用 import 顶替本地常量**

删除 `miner.js:88-123` 的 `_PHOTO_INSTR` / `SYSTEM` / `DEFAULT_STYLE` / `SYSTEM_FORCE` 四个 `const` 声明，在文件 import 区（紧跟现有 import 之后）加：

```javascript
import {
  MINE_SYSTEM as SYSTEM,
  MINE_SYSTEM_FORCE as SYSTEM_FORCE,
  PHOTO_INSTR as _PHOTO_INSTR,
  MINE_DEFAULT_STYLE as DEFAULT_STYLE,
} from "./prompts/mine.js";
```

> 用 `as` 别名保留 miner.js 内部原有名字（`SYSTEM`/`SYSTEM_FORCE`/`_PHOTO_INSTR`/`DEFAULT_STYLE`），其余代码一行不动。

- [ ] **Step 5: 跑新测试 + 全套，确认全绿**

Run: `cd agent && npx vitest run test/prompt-extraction.test.js && npm test`
Expected: PASS（新测试 4 条全过；既有套件全过，尤其 `usage_mine`、`photo-markers`、`moderation`、`model-config`）

- [ ] **Step 6: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git add agent/src/prompts/mine.js agent/src/miner.js agent/test/prompt-extraction.test.js
git commit -m "refactor(miner): 挖矿 prompt 文本外置到 src/prompts/mine.js（版本层单一真源）"
```

---

### Task 2: 从 `generateArticles` 抽出纯函数 `buildMinePrompt` + 导出 `parseArticles`

把「拼 payload」逻辑（含 Anthropic caching 断点）抽成不依赖 `env` 的纯函数，生产和 harness 共用。`generateArticles` 只剩 fetch + parse。

**Files:**
- Modify: `agent/src/miner.js`（`generateArticles` ≈ `:493-588`：抽出 `buildMinePrompt`，改写函数体；`parseArticles` ≈ `:419` 加 `export`）
- Test: `agent/test/build-mine-prompt.test.js`

**Interfaces:**
- Consumes: `MINE_SYSTEM`/`MINE_SYSTEM_FORCE`/`PHOTO_INSTR`/`MINE_DEFAULT_STYLE`（Task 1）、`ARTICLES_SCHEMA`（`miner.js:125`）。
- Produces:
  - `export function buildMinePrompt({ transcript, styleText, photos, force, cacheMode="system", provider="anthropic", model, systemPrompt=SYSTEM, forcePrompt=SYSTEM_FORCE, photoInstr=_PHOTO_INSTR, defaultStyle=DEFAULT_STYLE }) → payload`（请求体对象，不含 apiKey/baseUrl/fetch）。
  - `export function parseArticles(text) → [{title, body}]`。

- [ ] **Step 1: 写 buildMinePrompt 单测（先失败）**

Create `agent/test/build-mine-prompt.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { buildMinePrompt } from "../src/miner.js";

const T = "今天去看了一家咖啡馆。";

describe("buildMinePrompt — anthropic 默认 (system cache)", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "anthropic", model: "claude-opus-4-8" });
  it("system 是一个带 ephemeral 缓存的块", () => {
    expect(p.system).toHaveLength(1);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
  it("system 文本含 SYSTEM + style 尾巴（无个人文风时用默认 DNA）", () => {
    expect(p.system[0].text).toContain("你是这段录音的录制者");
    expect(p.system[0].text).toContain("<style>");
    expect(p.system[0].text).toContain("胸有成竹"); // DEFAULT_STYLE
  });
  it("user content 是 transcript", () => {
    expect(p.messages[0].role).toBe("user");
    expect(p.messages[0].content).toBe(`<transcript>\n${T}\n</transcript>`);
  });
  it("非 force 带 json_schema output_config", () => {
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.max_tokens).toBe(8000);
  });
});

describe("buildMinePrompt — 个人文风顶替默认", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "我的专属文风XYZ", photos: [], force: false, provider: "anthropic", model: "m" });
  it("style 槽用传入文风、不再含默认 DNA", () => {
    expect(p.system[0].text).toContain("我的专属文风XYZ");
    expect(p.system[0].text).not.toContain("胸有成竹");
  });
});

describe("buildMinePrompt — force 兜底", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "x", photos: [], force: true, provider: "anthropic", model: "m" });
  it("用 SYSTEM_FORCE、无 style、无 schema、max_tokens 2000", () => {
    expect(p.system[0].text).toContain("把下面的口述转写整理成一篇短文");
    expect(p.system[0].text).not.toContain("<style>");
    expect(p.output_config).toBeUndefined();
    expect(p.max_tokens).toBe(2000);
  });
});

describe("buildMinePrompt — 带照片", () => {
  const photos = [{ relKey: "photos/2026/a.jpg", label: "10:00:00", b64: "QUJD" }];
  const p = buildMinePrompt({ transcript: T, styleText: "", photos, force: false, provider: "anthropic", model: "m" });
  it("system 追加 PHOTO_INSTR", () => {
    expect(p.system[0].text).toContain("[[photo:<key>]]");
  });
  it("user content 含 image 块 + photo 标签", () => {
    const c = p.messages[0].content;
    expect(Array.isArray(c)).toBe(true);
    expect(c.some(b => b.type === "image" && b.source?.data === "QUJD")).toBe(true);
    expect(c.some(b => b.type === "text" && b.text.includes('<photo key="photos/2026/a.jpg"'))).toBe(true);
  });
});

describe("buildMinePrompt — transcript cache 模式（restyle）", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "风格A", photos: [], force: false, cacheMode: "transcript", provider: "anthropic", model: "m" });
  it("system 块不含 style 尾巴（移到 user 末尾）", () => {
    expect(p.system[0].text).not.toContain("<style>");
  });
  it("transcript 块带缓存断点、style 尾巴在其后", () => {
    const c = p.messages[0].content;
    expect(c[0].cache_control).toEqual({ type: "ephemeral" });
    expect(c[c.length - 1].text).toContain("<style>");
    expect(c[c.length - 1].text).toContain("风格A");
  });
});

describe("buildMinePrompt — openai-compat", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "openai-compat", model: "deepseek" });
  it("system 是字符串、user 是字符串、带 json_object", () => {
    expect(p.messages[0].role).toBe("system");
    expect(typeof p.messages[0].content).toBe("string");
    expect(p.messages[1].content).toBe(`<transcript>\n${T}\n</transcript>`);
    expect(p.response_format).toEqual({ type: "json_object" });
  });
});

describe("buildMinePrompt — 候选 prompt 可注入", () => {
  it("systemPrompt 参数顶替默认 SYSTEM", () => {
    const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "anthropic", model: "m", systemPrompt: "候选版本PROMPT" });
    expect(p.system[0].text).toContain("候选版本PROMPT");
    expect(p.system[0].text).not.toContain("你是这段录音的录制者");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/build-mine-prompt.test.js`
Expected: FAIL — `buildMinePrompt is not a function` / 未导出

- [ ] **Step 3: 在 miner.js 抽出并导出 `buildMinePrompt`**

在 `generateArticles` 之前插入这个纯函数（逻辑逐句对应现 `generateArticles` 的 payload 组装，行为不变）：

```javascript
// Pure prompt/payload builder — no env, no fetch, no billing/logging side effects.
// Shared by production generateArticles AND the eval harness (agent/eval/run-eval.mjs)
// so the prompt bytes are identical. cacheMode/provider behavior unchanged.
export function buildMinePrompt({
  transcript, styleText, photos, force, cacheMode = "system",
  provider = "anthropic", model,
  systemPrompt = SYSTEM, forcePrompt = SYSTEM_FORCE,
  photoInstr = _PHOTO_INSTR, defaultStyle = DEFAULT_STYLE,
}) {
  const hasPhotos = !!(photos?.length) && !force;
  const staticSystem = force ? forcePrompt : (systemPrompt + (hasPhotos ? photoInstr : ""));
  const effectiveStyle = (styleText && styleText.trim()) ? styleText.trim() : defaultStyle;
  const styleTail = !force ? `\n\n<style>\n${effectiveStyle}\n</style>` : "";
  const transcriptText = `<transcript>\n${transcript}\n</transcript>`;
  const transcriptCache = cacheMode === "transcript" && !force;

  if (provider === "openai-compat") {
    const system = staticSystem + styleTail;
    let userContent;
    if (!hasPhotos) {
      userContent = transcriptText;
    } else {
      userContent = [{ type: "text", text: transcriptText }];
      for (let i = 0; i < photos.length; i++) {
        userContent.push({ type: "text", text: `\n<photo key="${photos[i].relKey}" time="${photos[i].label}">` });
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photos[i].b64}`, detail: "low" } });
        userContent.push({ type: "text", text: `\n</photo>` });
      }
    }
    return {
      model,
      max_tokens: force ? 2000 : 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    };
  }

  // Anthropic — prompt caching via cache_control breakpoints
  const systemText = transcriptCache ? staticSystem : (staticSystem + styleTail);
  const systemBlocks = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
  let content;
  if (!hasPhotos) {
    if (transcriptCache) {
      content = [{ type: "text", text: transcriptText, cache_control: { type: "ephemeral" } }];
      if (styleTail) content.push({ type: "text", text: styleTail });
    } else {
      content = transcriptText;
    }
  } else {
    content = [{ type: "text", text: transcriptText }];
    for (let i = 0; i < photos.length; i++) {
      content.push({ type: "text", text: `\n<photo key="${photos[i].relKey}" time="${photos[i].label}">` });
      const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos[i].b64 } };
      if (transcriptCache && i === photos.length - 1) img.cache_control = { type: "ephemeral" };
      content.push(img);
      content.push({ type: "text", text: `\n</photo>` });
    }
    if (transcriptCache && styleTail) content.push({ type: "text", text: styleTail });
  }
  const payload = {
    model, max_tokens: force ? 2000 : 8000,
    system: systemBlocks,
    messages: [{ role: "user", content }],
  };
  if (!force) payload.output_config = { format: { type: "json_schema", schema: ARTICLES_SCHEMA } };
  return payload;
}
```

- [ ] **Step 4: 改写 `generateArticles` 调用 `buildMinePrompt`**

把 `generateArticles`（`:493-588`）函数体替换为（保留签名与返回结构不变）：

```javascript
async function generateArticles(transcript, claudeMd, photos, force, env, modelCfg, cacheMode = "system") {
  const payload = buildMinePrompt({
    transcript, styleText: claudeMd, photos, force, cacheMode,
    provider: modelCfg.provider, model: modelCfg.model,
  });
  const reqForLog = redactReqForLog(payload);
  const t0 = Date.now();
  let text, latencyMs, rawResp;

  if (modelCfg.provider === "openai-compat") {
    const resp = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${modelCfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    latencyMs = Date.now() - t0;
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    rawResp = await resp.json();
    text = rawResp.choices?.[0]?.message?.content || "";
  } else {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": modelCfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    latencyMs = Date.now() - t0;
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    rawResp = await resp.json();
    text = (rawResp.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }

  return { articles: parseArticles(text), latencyMs, rawResp, request: reqForLog };
}
```

- [ ] **Step 5: 导出 `parseArticles`**

把 `miner.js:419` 的 `function parseArticles(text) {` 改为 `export function parseArticles(text) {`。

- [ ] **Step 6: 跑全套确认零回退**

Run: `cd agent && npx vitest run test/build-mine-prompt.test.js && npm test`
Expected: PASS（buildMinePrompt 单测全过；既有套件全过——`generateArticles` 行为未变）

- [ ] **Step 7: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git add agent/src/miner.js agent/test/build-mine-prompt.test.js
git commit -m "refactor(miner): 抽出纯函数 buildMinePrompt + 导出 parseArticles（生产/harness 共用）"
```

---

### Task 3: 金标集脚手架（公私分离 + gitignore + 真实数据补充流程）

🔒 **隐私优先**：jianshuo.dev 是公开 repo。只把**合成种子**放 `fixtures/samples/`（提交），真实金标集放 `fixtures/local/`（gitignore），跑批产物 `runs/`（gitignore）。先落 gitignore，再放文件。

**Files:**
- Modify: `.gitignore`（加 eval 私有路径）
- Create: `agent/eval/fixtures/README.md`、`agent/eval/fixtures/samples/sample-001-multi-topic.json`、`agent/eval/fixtures/samples/sample-002-short-emotional.json`

**Interfaces:**
- Produces: fixture 文件格式 `{ id: string, transcript: string, photos?: [{relKey,label,b64}], tags: string[] }`，与 `buildMinePrompt` 的 `transcript`/`photos` 入参对齐。`loadFixtures`（Task 6）优先读 `fixtures/local/`，无则回退 `fixtures/samples/`。

- [ ] **Step 1: 先加 .gitignore（在放任何真实数据之前）**

在 `/Users/jianshuo/code/jianshuo.dev/.gitignore` 末尾追加：

```
# eval：真实录音转写与跑批产物是私人数据，公开 repo 绝不收
agent/eval/fixtures/local/
agent/eval/runs/
```

验证：`cd /Users/jianshuo/code/jianshuo.dev && git check-ignore agent/eval/fixtures/local/x.json agent/eval/runs/r/out.json`
Expected: 两条路径都被打印（= 已忽略）。

- [ ] **Step 2: 写 fixtures/README.md**

```markdown
# 挖矿 prompt 评估 · 金标集

每个 `*.json` 是一条冻结的金标录音转写。eval 时每个 prompt 版本都跑这同一组，差异即归因到 prompt。

🔒 **隐私**：jianshuo.dev 是公开 repo。
- `samples/` —— 仅**合成/脱敏**示例，可提交，只够自测流程。
- `local/` —— 真实录音转写，**已 gitignore**，绝不进公开 repo。eval 实跑用这里的。

格式：
{ "id": "001-multi-topic", "transcript": "...口述转写...", "photos": [], "tags": ["多主题","长"] }

photos（可选）：[{ "relKey": "photos/2026-xx/xx.jpg", "label": "HH:MM:SS", "b64": "<base64>" }]

覆盖维度（攒满 10–15 条时确保各维度都有）：长/短、单主题/多主题、带图/不带、情绪/技术/日常。

补满真实数据到 local/（需用户 VoiceDrop token，交互执行；**只取文本转写，不下 mp3**）：
1. 用 wjs-voicedrop skill 列出并取若干真实录音的转写（`vd list` → transcript 文本）。
2. 每条存成 `local/<id>.json`，按内容打 tags。权威备份在 VoiceDrop/R2，本地只是可重拉快照。
3. 冻结成文件才可复现；风格漂移后再换血。
```

- [ ] **Step 3: 写 2 条合成种子 fixture（到 samples/）**

`agent/eval/fixtures/samples/sample-001-multi-topic.json`：

```json
{
  "id": "sample-001-multi-topic",
  "transcript": "今天上午去陆家嘴见了个做芯片的朋友，聊了半天国产替代，他说其实最难的不是设计是良率。中午顺路去了家新开的咖啡馆，豆子是云南的，老板自己烘的，意外地好喝。下午回来想了想，其实创业也是一样，难的从来不是想法，是把良率做上去——也就是把一件事重复做对的能力。",
  "photos": [],
  "tags": ["多主题", "中等", "合成"]
}
```

`agent/eval/fixtures/samples/sample-002-short-emotional.json`：

```json
{
  "id": "sample-002-short-emotional",
  "transcript": "刚才那个会开得我有点累。不是事情难，是来回拉扯，明明十分钟能定的事拖了一个小时。我越来越觉得，效率低的根源不是能力，是没人敢拍板。",
  "photos": [],
  "tags": ["单主题", "短", "情绪", "合成"]
}
```

- [ ] **Step 4: 确认只提交了公开安全的内容**

Run: `cd /Users/jianshuo/code/jianshuo.dev && git add agent/eval/fixtures/ .gitignore && git status --short`
Expected: 只看到 `.gitignore`、`fixtures/README.md`、`fixtures/samples/sample-*.json`——**没有** `local/` 或 `runs/` 下任何文件。

- [ ] **Step 5: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git commit -m "feat(eval): 金标集脚手架——公私分离（samples 提交 / local+runs gitignore）+ README"
```

---

### Task 4: 确定性代理检查 `agent/eval/lib/proxy-checks.mjs`（纯函数，TDD）

零模型成本的硬检查：挡住明显坏的产出。`moderateArticles`（LLM 调用）不放这里，留给 Task 6 的 runner 单独跑。

**Files:**
- Create: `agent/eval/lib/proxy-checks.mjs`
- Test: `agent/test/eval-proxy-checks.test.js`

**Interfaces:**
- Produces: `export function runProxyChecks(articles, { transcript }) → { pass: boolean, checks: [{name, pass, detail}] }`。

- [ ] **Step 1: 写单测（先失败）**

Create `agent/test/eval-proxy-checks.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { runProxyChecks } from "../eval/lib/proxy-checks.mjs";

describe("runProxyChecks", () => {
  it("正常产出全过", () => {
    const r = runProxyChecks([{ title: "标题", body: "一段足够长的正文内容。".repeat(3) }], { transcript: "原始口述" });
    expect(r.pass).toBe(true);
    expect(r.checks.every(c => c.pass)).toBe(true);
  });
  it("空数组不过（articleCount）", () => {
    const r = runProxyChecks([], { transcript: "x" });
    expect(r.pass).toBe(false);
    expect(r.checks.find(c => c.name === "articleCount").pass).toBe(false);
  });
  it("缺标题不过", () => {
    const r = runProxyChecks([{ title: "", body: "正文正文正文" }], { transcript: "x" });
    expect(r.checks.find(c => c.name === "titlePresent").pass).toBe(false);
  });
  it("正文为空不过", () => {
    const r = runProxyChecks([{ title: "t", body: "   " }], { transcript: "x" });
    expect(r.checks.find(c => c.name === "bodyNonEmpty").pass).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/eval-proxy-checks.test.js`
Expected: FAIL — 无法 resolve `../eval/lib/proxy-checks.mjs`

- [ ] **Step 3: 写实现**

```javascript
// 确定性、零模型成本的产出健康检查。挡住明显坏的（JSON 已由调用方解析），
// 不做质量判断（质量交给 LLM 裁判）。moderateArticles 是 LLM 调用，不在此处。
export function runProxyChecks(articles, { transcript } = {}) {
  const arr = Array.isArray(articles) ? articles : [];
  const checks = [];
  const add = (name, pass, detail = "") => checks.push({ name, pass, detail });

  add("articleCount", arr.length > 0, `articles=${arr.length}`);
  add("titlePresent", arr.length > 0 && arr.every(a => (a.title || "").trim().length > 0), "每篇都要有非空标题");
  add("bodyNonEmpty", arr.length > 0 && arr.every(a => (a.body || "").trim().length > 0), "每篇正文非空");
  const tooShort = arr.filter(a => (a.body || "").trim().length < 10);
  add("bodyLengthSane", tooShort.length === 0, tooShort.length ? `${tooShort.length} 篇正文 <10 字` : "");

  return { pass: checks.every(c => c.pass), checks };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/eval-proxy-checks.test.js`
Expected: PASS（4 条全过）

- [ ] **Step 5: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git add agent/eval/lib/proxy-checks.mjs agent/test/eval-proxy-checks.test.js
git commit -m "feat(eval): 确定性代理检查 runProxyChecks"
```

---

### Task 5: 聚合与判定 `agent/eval/lib/aggregate.mjs`（纯函数，TDD）

把每条 fixture 的裁判结论汇总成胜率 + 维度统计 + 判定，并渲染 markdown 报告。

**Files:**
- Create: `agent/eval/lib/aggregate.mjs`
- Test: `agent/test/eval-aggregate.test.js`

**Interfaces:**
- Consumes: verdicts = `[{ fixtureId, winner: "candidate"|"champion"|"tie", dims?: object }]`；proxyFails = `[fixtureId,...]`（候选侧确定性回退的 fixture）。
- Produces:
  - `export function aggregate(verdicts, { threshold = 0.7, proxyFails = [] }) → { candidateWinRate, decisiveCount, wins, losses, ties, regressions, decision: "promote"|"hold" }`。
  - `export function renderReport(summary, { champRef, candRef }) → string`（markdown）。

- [ ] **Step 1: 写单测（先失败）**

Create `agent/test/eval-aggregate.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { aggregate, renderReport } from "../eval/lib/aggregate.mjs";

const V = (id, winner) => ({ fixtureId: id, winner });

describe("aggregate", () => {
  it("胜率按 decisive（去掉 tie）计", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","champion"), V("d","tie")], { threshold: 0.7 });
    expect(s.decisiveCount).toBe(3);
    expect(s.candidateWinRate).toBeCloseTo(2 / 3, 5);
    expect(s.ties).toBe(1);
  });
  it("胜率达标且无回退 → promote", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","candidate"), V("d","champion")], { threshold: 0.7 });
    expect(s.candidateWinRate).toBeCloseTo(0.75, 5);
    expect(s.decision).toBe("promote");
  });
  it("有确定性回退 → 一律 hold", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","candidate"), V("d","candidate")], { threshold: 0.7, proxyFails: ["a"] });
    expect(s.candidateWinRate).toBe(1);
    expect(s.regressions).toContain("a");
    expect(s.decision).toBe("hold");
  });
  it("胜率不达标 → hold", () => {
    const s = aggregate([V("a","candidate"), V("b","champion"), V("c","champion")], { threshold: 0.7 });
    expect(s.decision).toBe("hold");
  });
});

describe("renderReport", () => {
  it("含胜率与判定", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","champion")], { threshold: 0.7 });
    const md = renderReport(s, { champRef: "HEAD", candRef: "working" });
    expect(md).toContain("候选胜率");
    expect(md).toContain(s.decision === "promote" ? "晋级" : "保留");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/eval-aggregate.test.js`
Expected: FAIL — 无法 resolve `../eval/lib/aggregate.mjs`

- [ ] **Step 3: 写实现**

```javascript
// 把每条 fixture 的成对裁判结论汇总成胜率与判定。
// 判定规则：候选胜率 ≥ threshold 且无确定性回退 → promote；否则 hold。
// 人工认可那一票在 skill 流程里，不在此处。
export function aggregate(verdicts, { threshold = 0.7, proxyFails = [] } = {}) {
  const wins = verdicts.filter(v => v.winner === "candidate").length;
  const losses = verdicts.filter(v => v.winner === "champion").length;
  const ties = verdicts.filter(v => v.winner === "tie").length;
  const decisiveCount = wins + losses;
  const candidateWinRate = decisiveCount === 0 ? 0 : wins / decisiveCount;
  const regressions = [...new Set(proxyFails)];
  const decision = (candidateWinRate >= threshold && regressions.length === 0) ? "promote" : "hold";
  return { candidateWinRate, decisiveCount, wins, losses, ties, regressions, decision };
}

export function renderReport(summary, { champRef = "HEAD", candRef = "working" } = {}) {
  const pct = (summary.candidateWinRate * 100).toFixed(1);
  const verdict = summary.decision === "promote" ? "✅ 建议晋级（仍需人工抽查认可）" : "⏸ 保留生产版";
  const lines = [
    `# 挖矿 prompt 评估报告`,
    ``,
    `- 冠军（生产版）：\`${champRef}\``,
    `- 候选版：\`${candRef}\``,
    `- **候选胜率：${pct}%**（decisive ${summary.decisiveCount}：胜 ${summary.wins} / 负 ${summary.losses}，平 ${summary.ties}）`,
    summary.regressions.length ? `- ⚠️ 确定性回退 fixture：${summary.regressions.join(", ")}` : `- 确定性检查：全过`,
    ``,
    `## 判定`,
    ``,
    verdict,
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent && npx vitest run test/eval-aggregate.test.js`
Expected: PASS（aggregate 4 条 + renderReport 1 条）

- [ ] **Step 5: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git add agent/eval/lib/aggregate.mjs agent/test/eval-aggregate.test.js
git commit -m "feat(eval): 聚合判定 aggregate + markdown 报告 renderReport"
```

---

### Task 6: 编排 `agent/eval/run-eval.mjs`（注入式 callModel，TDD 编排）

读 fixtures，对每条用「冠军 prompt」「候选 prompt」各跑一次 `buildMinePrompt` → 调模型 → `parseArticles` → `runProxyChecks`，把两版产出写进 `runs/<runId>/`。模型调用通过依赖注入，便于单测；CLI 入口用真实 Anthropic fetch。

**Files:**
- Create: `agent/eval/run-eval.mjs`
- Test: `agent/test/eval-run.test.js`

**Interfaces:**
- Consumes: `buildMinePrompt`、`parseArticles`（Task 2）、`runProxyChecks`（Task 4）、`MINE_MODEL_DEFAULT`（`miner.js:21`）。
- Produces:
  - `export async function runEval({ fixtures, champSystem, candSystem, callModel, model }) → { runId?, results: [{ fixtureId, champion, candidate }] }`，其中 `callModel(payload) → rawText`（注入）；每个 `champion`/`candidate` = `{ articles, proxy }`。
  - `export function loadFixtures(dir) → fixture[]`。

- [ ] **Step 1: 写编排单测（注入 fake callModel，先失败）**

Create `agent/test/eval-run.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { runEval } from "../eval/run-eval.mjs";

const fixtures = [
  { id: "f1", transcript: "甲乙丙", photos: [], tags: [] },
  { id: "f2", transcript: "丁戊己", photos: [], tags: [] },
];

// fake 模型：冠军 prompt 回一篇，候选 prompt 回两篇——靠 system 文本区分
function fakeCallModel(payload) {
  const sys = payload.system?.[0]?.text || "";
  if (sys.includes("CAND")) {
    return JSON.stringify({ articles: [{ title: "A", body: "正文一二三四五" }, { title: "B", body: "正文一二三四五" }] });
  }
  return JSON.stringify({ articles: [{ title: "C", body: "正文一二三四五" }] });
}

describe("runEval（注入式）", () => {
  it("每条 fixture 跑出冠军/候选两份产出 + 代理检查", async () => {
    const r = await runEval({
      fixtures, champSystem: "CHAMP-PROMPT", candSystem: "CAND-PROMPT",
      callModel: fakeCallModel, model: "test-model",
    });
    expect(r.results).toHaveLength(2);
    const f1 = r.results.find(x => x.fixtureId === "f1");
    expect(f1.champion.articles).toHaveLength(1);
    expect(f1.candidate.articles).toHaveLength(2);
    expect(f1.champion.proxy.pass).toBe(true);
    expect(f1.candidate.proxy.pass).toBe(true);
  });
  it("候选 prompt 经 systemPrompt 注入（产出受候选影响）", async () => {
    const r = await runEval({
      fixtures: [fixtures[0]], champSystem: "X", candSystem: "CAND-PROMPT",
      callModel: fakeCallModel, model: "m",
    });
    expect(r.results[0].candidate.articles.map(a => a.title)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent && npx vitest run test/eval-run.test.js`
Expected: FAIL — 无法 resolve `../eval/run-eval.mjs`

- [ ] **Step 3: 写实现（含真实 Anthropic CLI 入口）**

```javascript
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMinePrompt, parseArticles, MINE_MODEL_DEFAULT } from "../src/miner.js";
import { runProxyChecks } from "./lib/proxy-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 优先用真实金标集 fixtures/local/（gitignore，私人数据）；没有则回退到合成 samples/。
export function loadFixtures() {
  const local = join(HERE, "fixtures", "local");
  const dir = (existsSync(local) && readdirSync(local).some(f => f.endsWith(".json")))
    ? local : join(HERE, "fixtures", "samples");
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// callModel(payload) → rawText（注入，便于测试）。
export async function runEval({ fixtures, champSystem, candSystem, callModel, model }) {
  const results = [];
  for (const fx of fixtures) {
    const runOne = async (systemPrompt) => {
      const payload = buildMinePrompt({
        transcript: fx.transcript, styleText: "", photos: fx.photos || [],
        force: false, provider: "anthropic", model, systemPrompt,
      });
      const raw = await callModel(payload);
      let articles = [];
      try { articles = parseArticles(raw); } catch { articles = []; }
      return { articles, proxy: runProxyChecks(articles, { transcript: fx.transcript }) };
    };
    results.push({
      fixtureId: fx.id,
      champion: await runOne(champSystem),
      candidate: await runOne(candSystem),
    });
  }
  return { results };
}

// ── 真实 Anthropic 调用（CLI 入口用）──
async function anthropicCallModel(payload) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺 CLAUDE_API_KEY 环境变量");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// CLI: node eval/run-eval.mjs <candidatePromptFile> [runId]
// 冠军 = 当前 src/prompts/mine.js 的 MINE_SYSTEM；候选 = 文件内容。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { MINE_SYSTEM } = await import("../src/prompts/mine.js");
  const candFile = process.argv[2];
  if (!candFile) { console.error("用法: node eval/run-eval.mjs <candidatePromptFile> [runId]"); process.exit(1); }
  const candSystem = readFileSync(candFile, "utf8");
  const runId = process.argv[3] || "run-local";
  const fixtures = loadFixtures();
  const { results } = await runEval({
    fixtures, champSystem: MINE_SYSTEM, candSystem,
    callModel: anthropicCallModel, model: MINE_MODEL_DEFAULT,
  });
  const outDir = join(HERE, "runs", runId);
  mkdirSync(join(outDir, "outputs"), { recursive: true });
  for (const r of results) {
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.champion.json`), JSON.stringify(r.champion, null, 2));
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.candidate.json`), JSON.stringify(r.candidate, null, 2));
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`✓ ${results.length} 条 fixture 已跑完，产出在 eval/runs/${runId}/`);
  const proxyFails = results.filter(r => !r.candidate.proxy.pass).map(r => r.fixtureId);
  if (proxyFails.length) console.log(`⚠️ 候选侧确定性回退: ${proxyFails.join(", ")}`);
}
```

- [ ] **Step 4: 跑编排单测确认通过**

Run: `cd agent && npx vitest run test/eval-run.test.js`
Expected: PASS（2 条）

- [ ] **Step 5: 跑全套确认无回退**

Run: `cd agent && npm test`
Expected: PASS（全绿）

- [ ] **Step 6: Commit**

```bash
cd /Users/jianshuo/code/jianshuo.dev
git add agent/eval/run-eval.mjs agent/test/eval-run.test.js
git commit -m "feat(eval): run-eval 编排（注入式 callModel + Anthropic CLI 入口）"
```

---

### Task 7: Skill —— `wjs-evaling-voicedrop-prompts`（编排协议 + 裁判 rubric）

skill 是 harness 的「协议层」：告诉 Claude Code 怎么调 `agent/eval/` 的脚本、怎么 dispatch 裁判 subagent、怎么聚合与晋级。

**Files:**
- Create: `~/.claude/skills/wjs-evaling-voicedrop-prompts/SKILL.md`
- Create: `~/.claude/skills/wjs-evaling-voicedrop-prompts/references/judge-rubric.md`

- [ ] **Step 1: 写 `references/judge-rubric.md`**

```markdown
# 挖矿 prompt 成对盲评 · 裁判 rubric（单一真源）

你是公众号写作的资深编辑，盲评两份「同一段口述被挖成的文章」，判断哪份更好。
你不知道哪份来自哪个 prompt 版本。

输入：原始口述转写 + 产出 A + 产出 B（A/B 顺序已随机）。

逐维度比较（每个维度判 A 优 / B 优 / 相当，并给一句理由）：
1. 选题切分——是否正确识别不同主题、切成恰当篇数（默认少而厚）。
2. 标题——是否胸有成竹的断言式、不是小白提问钩子。
3. 文风像王建硕——平实诚恳、不讲故事铺垫、细节用表格/列表、不加 AI 味连接词。
4. 忠实不编造——严格只用转写里的事实，无凭空捏造。**任一份违反 → 该份此维度判负，且总判不能给它赢。**
5. 完整性——关键要点没漏。

只输出 JSON：
{ "winner": "A" | "B" | "tie", "dims": { "选题切分":"A|B|tie", "标题":"...", "文风":"...", "忠实":"...", "完整性":"..." }, "reason": "一句话总结" }
```

- [ ] **Step 2: 写 `SKILL.md`**

```markdown
---
name: wjs-evaling-voicedrop-prompts
description: Use when 王建硕 wants to evaluate whether a change to VoiceDrop's 挖矿 system prompt is actually better than the live version — runs the local eval harness (golden fixtures × champion-vs-candidate, same input), dispatches blind pairwise judge subagents, aggregates a win-rate verdict, and on approval promotes the candidate into agent/src/prompts/mine.js. Triggers — "评估 prompt"、"挖矿 prompt 改好了吗"、"eval prompt"、"比一比两版 prompt"、"/wjs-evaling-voicedrop-prompts".
---

# VoiceDrop 挖矿 prompt 评估

harness = 本 skill（协议）+ jianshuo.dev `agent/eval/`（脚本/数据）。运行时 = 本地 Claude Code。
被测对象 = `agent/src/prompts/mine.js` 的 `MINE_SYSTEM`（git 即版本库）。

## 何时用
用户改了挖矿 prompt（`MINE_SYSTEM`），想用数据判断改好了还是改坏了，而不是凭感觉看一两次。

## 流程（按序）

1. **拿候选 prompt**：把候选版 `MINE_SYSTEM` 文本写到一个临时文件（如 `/tmp/cand-prompt.txt`）；冠军 = 当前 `mine.js` 的 `MINE_SYSTEM`（脚本自动读）。
2. **跑产出**：`cd ~/code/jianshuo.dev/agent && CLAUDE_API_KEY=$CLAUDE_API_KEY node eval/run-eval.mjs /tmp/cand-prompt.txt <runId>`。产出落 `eval/runs/<runId>/`。先看终端有没有「确定性回退」警告——有就先停，多半是候选 prompt 破坏了 JSON 输出。
3. **成对盲评**：对每条 fixture，dispatch 一个 subagent，喂 `references/judge-rubric.md` + 该 fixture 的 transcript + 两份产出。**A/B 顺序随机**（一半 fixture 把 candidate 放 A、一半放 B，记录映射，收到结果后还原成 champion/candidate）。裁判模型用与生成（opus）不同家族的模型。收每条的 `{winner, dims, reason}`。
4. **聚合**：把还原后的 `verdicts`（winner ∈ candidate/champion/tie）+ 候选 proxyFails 喂 `aggregate()`，渲染 `renderReport()` → 写 `eval/runs/<runId>/report.md`。
5. **人工终审**：把胜负最接近、分歧最大的 1–2 条产出并排摆给用户。**机器只筛掉明显更差的，文风最后一票是用户。**
6. **晋级**：仅当 `decision==="promote"`（胜率 ≥70% 且无回退）**且用户点「认可」**——把候选写回 `agent/src/prompts/mine.js` 的 `MINE_SYSTEM`，commit（message 附 runId 与胜率），并跑 `npm test` 确认没破坏。否则保留报告、不动生产版。

## 边界
- 只评挖矿 prompt（`MINE_SYSTEM`/`MINE_SYSTEM_FORCE`）。审核/语音编辑 prompt 是不同 eval 模式，不在本 skill。
- 不测成本/缓存/延迟（本地缓存行为≠生产）；不做无人值守。
- 真实金标集要 ≥10 条才可信（见 `agent/eval/fixtures/README.md` 的补充流程）；种子 2 条只够自测流程。
```

- [ ] **Step 3: 校验 skill 能被发现**

Run: `ls ~/.claude/skills/wjs-evaling-voicedrop-prompts/ && head -5 ~/.claude/skills/wjs-evaling-voicedrop-prompts/SKILL.md`
Expected: 列出 SKILL.md + references/，frontmatter 含 `name: wjs-evaling-voicedrop-prompts`

- [ ] **Step 4: Commit（按用户 skill 工作流：直接在 main 改+提交；wjs-* 会自动同步公开 repo）**

```bash
cd ~/.claude/skills
git add wjs-evaling-voicedrop-prompts/
git commit -m "feat(skill): wjs-evaling-voicedrop-prompts —— 挖矿 prompt 成对盲评 harness"
```

> 若 `~/.claude/skills` 非 git 仓库或无远端，跳过 commit，仅落盘即可（skills-publish-hook 负责同步 wjs-* skill）。

---

### Task 8: 端到端 dry run + 验收

用种子 fixture 跑一整轮，确认管道贯通、既有挖矿行为零变化。

- [ ] **Step 1: 全套测试**

Run: `cd /Users/jianshuo/code/jianshuo.dev/agent && npm test`
Expected: PASS（含新增 4 个测试文件 + 既有全部）

- [ ] **Step 2: 真实一轮（需 CLAUDE_API_KEY）**

构造一个「明显更差」的候选 prompt 验证管道辨别力：

```bash
cd /Users/jianshuo/code/jianshuo.dev/agent
printf '把转写复述一遍即可，不用整理，不用标题。' > /tmp/cand-prompt.txt
CLAUDE_API_KEY=$CLAUDE_API_KEY node eval/run-eval.mjs /tmp/cand-prompt.txt dryrun-1
```
Expected: `eval/runs/dryrun-1/` 生成 `results.json` + `outputs/*.json`；终端打印 2 条跑完。

- [ ] **Step 3: 走一遍 skill 的裁判 + 聚合（手动验证）**

按 SKILL.md 步骤 3–4，对 2 条 fixture dispatch 裁判 subagent、聚合出 `report.md`。Expected：报告含候选胜率与判定；这个「明显更差」的候选应判 hold。

- [ ] **Step 4: 验收对照 spec**

逐条核对 `docs/superpowers/specs/2026-06-30-evaling-voicedrop-prompts-design.md` §14：
1. `mine.js` 存在、生产经 `buildMinePrompt` 读它、`npm test` 全绿（线上行为零变化）✓
2. fixtures 目录有种子 + README（真实补满流程已记录）✓
3. 一条命令跑完整一轮 ✓
4. 报告含每条胜负/维度/胜率/判定建议 ✓
5. 晋级路径在 SKILL.md 写明（promote + 人工认可 → 写回 mine.js + commit）✓
6. 全程本地 Claude Code，无需部署 Worker ✓

- [ ] **Step 5: 🔒 确认跑批产物没进 git（隐私验收）**

Run: `cd /Users/jianshuo/code/jianshuo.dev && git status --short && git check-ignore agent/eval/runs/dryrun-1/results.json`
Expected: `git status` 里**看不到** `agent/eval/runs/` 任何文件；`check-ignore` 打印该路径（= 已忽略）。dryrun 产物留在本地磁盘即可，不提交。

---

## Self-Review

**Spec coverage：**
- §3 双层 → Task 1（版本层）+ Task 2/4/5/6（效果层）✓
- §4.1 prompt 外置 → Task 1（决定用 `.js` 模块，spec §4.1/§15 允许的回退）✓
- §4.2 buildMinePrompt 纯函数 → Task 2 ✓
- §5 目录结构 → Task 1/3/6/7（调整：runner 脚本放 `agent/eval/` 而非 skill 目录，因其 import 生产代码，避免跨 repo 路径脆弱；spec §5 的脚本位置据此细化，skill 保留协议+rubric）✓
- §6 流程 → Task 6（runner）+ Task 7（裁判/聚合/判定编排）✓
- §7 金标集 → Task 3 ✓
- §8 裁判 rubric → Task 7 `judge-rubric.md` ✓
- §9 报告 → Task 5 `renderReport` ✓
- §10 skill 交互 → Task 7 `SKILL.md` ✓
- §11 v1 范围 → Global Constraints + Task 7 边界 ✓
- §12 非目标 → Global Constraints + SKILL.md 边界 ✓
- §13 风险（裁判漂移=rubric 单一真源；prompt 漂移=共用 buildMinePrompt；噪声=多 fixture+随机+异家族）✓
- §14 验收 → Task 8 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码；prompt 文本为现有字面值逐字搬运（非新造）。✓

**Type consistency：** `buildMinePrompt` 签名/`parseArticles` 导出在 Task 2 定义，Task 6 按同签名 import；`runProxyChecks(articles,{transcript})` Task 4 定义、Task 6 同形调用；`aggregate(verdicts,{threshold,proxyFails})`/`renderReport(summary,{champRef,candRef})` Task 5 定义、SKILL.md 按此编排；fixture 格式 `{id,transcript,photos?,tags}` Task 3 定义、Task 6 `loadFixtures`/`runEval` 一致消费。✓

**已知偏离 spec（均在 spec 授权范围内 / 修正 spec 疏漏）：**
1. prompt 存 `.js` 而非 `.md`（spec §4.1/§15 明确允许的回退；理由：单一 import 路径、零 bundler 配置、防漂移）。
2. runner 脚本住 `agent/eval/` 而非 skill 目录（理由：import 生产代码，跨 repo 路径脆弱）。skill 仍持有协议 + 裁判 rubric，符合「harness=skill，Claude Code=运行时」。
3. **🔒 数据隐私（修正 spec 疏漏）**：spec §9 暗示把 `runs/report.md` git-diff（即提交）。但 jianshuo.dev 是 PUBLIC repo，真实转写与产出是私人数据——本计划改为 `local/` + `runs/` gitignore，只提交合成 `samples/`。spec 已同步补 §16 数据隐私。
