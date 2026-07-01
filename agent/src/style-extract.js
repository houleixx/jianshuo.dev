// 把风格数据集（外部素材样本，users/<sub>/style/<id>.json）蒸馏成一段「写作风格」描述。
// 纯逻辑：Claude 调用注入（`claude({system,messages}) -> string`），便于单元测试；
// 真实调用+计费+日志由 agent/src/index.js 的路由处理包装后注入。
export const DISTILL_SYSTEM = `你是文风分析师。下面是用户收集的若干篇「他欣赏/想学」的文章样本。
请提炼出一套可复用的中文写作风格描述（第二人称「你」写给写作助手看）：语气、句式长短、用词偏好、段落节奏、标点习惯、爱用/避免的表达。
只输出风格描述本身，150–400 字，不要复述样本内容、不要分点编号堆砌。`;

export async function distillStyle(samples, claude) {
  if (!samples || !samples.length) throw new Error("empty-dataset");
  const corpus = samples
    .map((s, i) => {
      const title = s.title || s.sourceFile || "";
      return `【样本${i + 1}${title ? "·" + title : ""}】\n${(s.text || "").slice(0, 4000)}`;
    })
    .join("\n\n");
  const style = await claude({ system: DISTILL_SYSTEM, messages: [{ role: "user", content: corpus }] });
  return (style || "").trim();
}
