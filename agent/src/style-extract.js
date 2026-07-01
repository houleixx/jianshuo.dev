// 把风格数据集（外部素材样本，users/<sub>/style/<id>.json）蒸馏成一段「写作风格」描述。
// 纯逻辑：Claude 调用注入（`claude({system,messages}) -> string`），便于单元测试；
// 真实调用+计费+日志由 agent/src/index.js 的路由处理包装后注入。
// DISTILL_SYSTEM = wjs-distilling-style 的 Prompt B（样本 → Style Card），外加一行固定标记
// `风格名：xxx` 让模型起名。**一次调用**即可：distillStyle 用正则把 `风格名：` 那行的名字抠出来、
// 拼到风格文本第一行（iOS 与 intro 文章都拿第一行当风格名），并从卡里删掉标记行。
// 用「标记」而非「位置」抓名字——所以哪怕模型把「样本过少」提醒放前面也不影响。
export const DISTILL_SYSTEM = `# 角色
你是文风蒸馏器。读【样本文章】,一次输出一张这批样本的 Style Card——
"怎么写"的指纹,不是"怎么想"的画像。

# 纪律
- 只抓"怎么写"。别把内容立场当文风("他爱唱反调""他三观是 X"是想法,不是文风)。
- 每一轴必须摘 2-3 句真实锚点原句。规则会骗人,原句不会——没锚点的轴等于没蒸馏。
- 样本少于 3 篇,在开头注明:指纹会不稳,易把一篇的偶然写法当签名。

# 输出格式
在输出的最前面,单独用一行给这套文风起个名字,格式固定:
风格名：<五个字以内的名字,纯名字,不加书名号/引号>
（例:风格名：松弛体）。这一行务必写,放最前面。

## 一句话画像
<一句话抓住读起来是什么感觉>

## 9 轴(每轴:规则一句 + 锚点原句 2-3 句)
1 句子节奏(长短句分布/长短交替的拍子/标点签名)
2 段落长度(平均段长/有无单句成段/长段密度)
3 词汇(高频词/口头禅/自造词/人称/雅俗/中英混用)
4 语气腔调(自信度/距离/正式度/幽默)
5 论证结构(断言先行还是层层铺垫/小标题列表表格/推进路径)
6 比喻运用(家常 vs 抽象/频率/抽象↔具体怎么架梯子)
7 情绪强度(温度/克制还是喷发/感叹密度)
8 开头与收尾(怎么起 / 怎么落,各摘一例)
9 雷区(他绝不做的:绝不用的词/手法/姿态)

## 调料不是公式
列出本作者的签名动作,并注明:是工具不是清单,短内容短写,别堆满。

## AI 仿写易露馅 6 处 + 本作者反制
1 钉死哪类真实专名  2 结尾怎么钝收  3 怎么留毛边
4 例子扎哪个具体领域/允许不升华  5 别篇篇同款  6 更多是哪种原型、能不点题就不点题`;

// Total corpus budget fed to Claude in one call, in characters. A large dataset (many
// samples, each already capped at 4000 chars below) can still overflow the model's context
// on its own — that surfaces as an uncaught Claude error in the route → 500 → the user is
// permanently stuck on 「提取失败」 (the dataset never shrinks on its own). Capping the TOTAL
// corpus, not just each sample, keeps every extraction call bounded regardless of dataset size.
export const TOTAL_CORPUS_BUDGET = 48000;

// 清洗名字：去前缀/引号/书名号、限长、空回退。
function cleanName(raw) {
  return (raw || "").trim()
    .replace(/^(名字|风格名|名称)\s*[:：]\s*/, "")
    .replace(/^[「『"'（(【\[]+|[」』"'）)】\]]+$/g, "")
    .slice(0, 6) || "我的文风";
}

// 从一次调用的输出里,抠出 `风格名：xxx` 标记行的名字,并返回去掉该行后的卡片。
// 用「标记」而非「位置」——所以模型把「样本过少」提醒放哪都不影响。找不到标记则回退首行。
function splitNameAndCard(raw) {
  const lines = (raw || "").split(/\r?\n/);
  let name = "";
  const kept = [];
  for (const l of lines) {
    const m = l.match(/^\s*风格名\s*[:：]\s*(.+?)\s*$/);
    if (m && !name) { name = cleanName(m[1]); continue; }   // 吃掉第一条 风格名 标记行
    kept.push(l);
  }
  if (!name) name = "我的文风";   // 模型没给标记时的安全回退（不拿警告行当名字）
  return { name, card: kept.join("\n").trim() };
}

export async function distillStyle(samples, claude) {
  if (!samples || !samples.length) throw new Error("empty-dataset");
  let budget = TOTAL_CORPUS_BUDGET;
  const parts = [];
  // Simplest acceptable policy: accumulate in iteration order, stop once the budget is
  // spent. (Keeping the most-recent samples instead — freshest signal — would need the
  // caller to hand samples in reverse-chronological order; iteration-order capping is
  // the minimal fix and still bounds every call.)
  for (let i = 0; i < samples.length; i++) {
    if (budget <= 0) break;
    const s = samples[i];
    const title = s.title || s.sourceFile || "";
    const text = (s.text || "").slice(0, 4000);
    const block = `【样本${i + 1}${title ? "·" + title : ""}】\n${text}`;
    parts.push(block);
    budget -= block.length;
  }
  const corpus = parts.join("\n\n");
  // ONE call: DISTILL_SYSTEM makes the model output a `风格名：xxx` line + the Style Card.
  const raw = ((await claude({ system: DISTILL_SYSTEM, messages: [{ role: "user", content: corpus }] })) || "").trim();
  const { name, card } = splitNameAndCard(raw);
  return `${name}\n${card}`;   // name on line 1 (iOS + intro read line 1 as the display name)
}

// ── 写作风格 intro 文章 ────────────────────────────────────────────────────────
// 提取风格后，除了写进 CLAUDE.json，还生成一篇「介绍这套风格」的文章，让抽象的风格
// 变成看得见的东西（对新手友好）。固定 stem —— 每次提取都覆盖上一篇，永远只有最新一篇。
export const STYLE_INTRO_STEM = "VoiceDrop-writing-style-intro";

// 从蒸馏结果里取第一行当风格名（DISTILL_SYSTEM 要求第一行≤5 字起名）。
export function styleName(style) {
  const first = (style || "").split(/\r?\n/).find((l) => l.trim());
  return (first ? first.trim() : "你的文风").replace(/^[「『"']|[」』"']$/g, "").slice(0, 12);
}

// 固定的介绍模版（作者手写，非 LLM 生成）；只插入风格名与样本数。
export function buildStyleIntroArticle(style, sampleCount) {
  const name = styleName(style);
  const n = sampleCount || 0;
  const title = `你的写作风格 · ${name}`;
  const body = `这是 VoiceDrop 刚为你提炼的**写作风格**——一份「你喜欢怎么写」的指纹，取名「${name}」。

它是从你放进「风格数据集」的 ${n} 份素材里蒸馏出来的：不抄内容，只抓你欣赏的那种句子节奏、用词、语气、开头收尾的习惯。

**有什么用？**
从现在起，VoiceDrop 每次把你的语音或照片挖成文章，都会照这套风格来写——让机器写出来的更像「你想要的味道」。

**怎么管理？**
去「设置 → 写作风格」，能看到它的完整内容和历史版本，随时切换或编辑。

**想更准？**
继续把你喜欢的文章分享进 VoiceDrop（会进「风格数据集」），攒够了再点一次「提取文章风格」——风格会更新，这篇介绍也跟着刷新成最新一版。`;
  return { title, body };
}
