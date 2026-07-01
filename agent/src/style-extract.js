// 把风格数据集（外部素材样本，users/<sub>/style/<id>.json）蒸馏成一段「写作风格」描述。
// 纯逻辑：Claude 调用注入（`claude({system,messages}) -> string`），便于单元测试；
// 真实调用+计费+日志由 agent/src/index.js 的路由处理包装后注入。
export const DISTILL_SYSTEM = `你是文风分析师。下面是用户收集的若干篇「他欣赏/想学」的文章样本。
请提炼出一套可复用的中文写作风格描述（第二人称「你」写给写作助手看）：语气、句式长短、用词偏好、段落节奏、标点习惯、爱用/避免的表达。
只输出风格描述本身，150–400 字，不要复述样本内容、不要分点编号堆砌。`;

// Total corpus budget fed to Claude in one call, in characters. A large dataset (many
// samples, each already capped at 4000 chars below) can still overflow the model's context
// on its own — that surfaces as an uncaught Claude error in the route → 500 → the user is
// permanently stuck on 「提取失败」 (the dataset never shrinks on its own). Capping the TOTAL
// corpus, not just each sample, keeps every extraction call bounded regardless of dataset size.
export const TOTAL_CORPUS_BUDGET = 48000;

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
  const style = await claude({ system: DISTILL_SYSTEM, messages: [{ role: "user", content: corpus }] });
  return (style || "").trim();
}
