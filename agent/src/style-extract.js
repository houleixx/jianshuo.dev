// 把风格数据集（外部素材样本，users/<sub>/style/<id>.json）蒸馏成一段「写作风格」描述。
// 纯逻辑：Claude 调用注入（`claude({system,messages}) -> string`），便于单元测试；
// 真实调用+计费+日志由 agent/src/index.js 的路由处理包装后注入。
// DISTILL_SYSTEM 现在住在 ./prompts/style.js（单一真源，字面量未变，仅搬迁）。
import { DISTILL_SYSTEM } from "./prompts/style.js";
export { DISTILL_SYSTEM };

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

// ── 语料充足性 ────────────────────────────────────────────────────────────────
// 蒸馏前的确定性硬闸：语料有效字数低于这个数就不值得（也不允许）蒸馏。只有书名 /
// 一句话的语料会逼出一张「样本不足，无法蒸馏」的说明卡——那张卡若照常 writeStyleDoc
// 落成版本，还会成为用户的生效文风（挖矿时被当文风注入 prompt）。300 字 ≈ 两三个
// 真实段落，是能抓到句子节奏的最少样本量。两条提取路径（miner 任务 + 同步路由）和
// 分享扩展的前置拦截（StyleDatasetView.minExtractChars）共用这个口径。
export const MIN_CORPUS_CHARS = 300;

// 数据集的可蒸馏字数——与 /style/collect 记的 `chars` 同口径（code points）。
export function corpusChars(samples) {
  return (samples || []).reduce((n, s) => n + [...((s && s.text) || "").trim()].length, 0);
}

// 素材清单行（标题缺失退回来源/文件名）——intro 文章与「样本不足」反馈共用。
function sampleListLines(list, max = 50) {
  const shown = (list || []).slice(0, max);
  const lines = shown.map((s, i) => {
    const t = ((s && (s.title || s.sourceFile)) || "").toString().trim().slice(0, 40);
    const src = ((s && s.source) || "").toString().trim();
    const label = t || src || "（无标题素材）";
    const tail = src && src !== label ? ` — ${src}` : "";
    return `${i + 1}. ${label}${tail}`;
  }).join("\n");
  const more = (list || []).length > max ? `\n…还有 ${list.length - max} 份（共 ${list.length} 份）` : "";
  return lines + more;
}

// 语料不够时的反馈文章（不写风格版本！）——走和成功时同一条「结果=一篇文章」通道，
// 用户在「我的录音」里能看到为什么没成、该怎么补。
export function buildInsufficientCorpusArticle(samples, totalChars) {
  const list = Array.isArray(samples) ? samples : [];
  const title = "样本不足，风格没有更新";
  const body = `你分享进来的素材加起来只有 **${totalChars} 个字**（不足 ${MIN_CORPUS_CHARS} 字）——多半只有标题或链接，没有正文。字数太少提炼不出真实的写作指纹，硬提只会得到一张编造的卡，所以这次**没有改动你的写作风格**，当前生效的还是原来那一版。

**这次收到的素材（${list.length} 份）：**
${sampleListLines(list)}

**怎么补？**
回到原 app，把文章的**正文**分享进来——选中正文文字再分享，或分享一个能解析出正文的网页链接（微信读书这类 app 的「分享」往往只带书名，不带正文）。攒够几个段落，再点一次「提取文章风格」就行，这些素材都还在数据集里。`;
  return { title, body };
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

// 固定的介绍模版（作者手写，非 LLM 生成）；插入风格名、样本数，以及这次蒸馏用到的素材清单。
// `samples` 可传样本数组（渲染清单）或一个数字（只当计数，向后兼容旧调用）。
export function buildStyleIntroArticle(style, samples) {
  const list = Array.isArray(samples) ? samples : [];
  const n = Array.isArray(samples) ? list.length : (samples || 0);
  const name = styleName(style);
  const title = `你的写作风格 · ${name}`;

  // 素材清单：让用户看清这套风格是从哪几篇里挖出来的。标题缺失时退回来源/文件名。
  const materials = list.length
    ? `\n\n**这次是从这些素材里蒸出来的（${n} 份）：**\n${sampleListLines(list)}`
    : "";

  const body = `这是 VoiceDrop 刚为你提炼的**写作风格**——一份「你喜欢怎么写」的指纹，取名「${name}」。

它是从你放进「风格数据集」的 ${n} 份素材里蒸馏出来的：不抄内容，只抓你欣赏的那种句子节奏、用词、语气、开头收尾的习惯。${materials}

**有什么用？**
从现在起，VoiceDrop 每次把你的语音或照片挖成文章，都会照这套风格来写——让机器写出来的更像「你想要的味道」。

**怎么管理？**
去「设置 → 写作风格」，能看到它的完整内容和历史版本，随时切换或编辑。

**想更准？**
继续把你喜欢的文章分享进 VoiceDrop（会进「风格数据集」），攒够了再点一次「提取文章风格」——风格会更新，这篇介绍也跟着刷新成最新一版。`;
  return { title, body };
}
