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
  stageSystem = STAGE_SYSTEM,
}) {
  const sys = stageSystem[stage];
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

  // anthropic —— 注意不发 temperature：claude-opus-4.8 起该参数被 API 拒收
  //（400 "temperature is deprecated for this model"，eval run image-gate-01 实锤）。
  // 阶段温度只对 openai-compat 生效；Anthropic 侧用 prompt 措辞控制发挥度。
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
    model, max_tokens,
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
