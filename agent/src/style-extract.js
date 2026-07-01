// 把风格数据集（外部素材样本，users/<sub>/style/<id>.json）蒸馏成一段「写作风格」描述。
// 纯逻辑：Claude 调用注入（`claude({system,messages}) -> string`），便于单元测试；
// 真实调用+计费+日志由 agent/src/index.js 的路由处理包装后注入。
// 蒸馏提示词 = wjs-distilling-style 的 Prompt B（样本 → Style Card），
// 外加「输出第一行用五个字以内起个名字」——第一行的名字被 iOS 当作这版写作风格的显示名。
export const DISTILL_SYSTEM = `# 角色
你是文风蒸馏器。读【样本文章】,一次输出一张这批样本的 Style Card——
"怎么写"的指纹,不是"怎么想"的画像。

# 纪律
- 只抓"怎么写"。别把内容立场当文风("他爱唱反调""他三观是 X"是想法,不是文风)。
- 每一轴必须摘 2-3 句真实锚点原句。规则会骗人,原句不会——没锚点的轴等于没蒸馏。
- 样本少于 3 篇,在开头注明:指纹会不稳,易把一篇的偶然写法当签名。

# 输出格式
输出的第一行:用五个字以内给这套文风起个名字(只有名字本身,不加标点、不加书名号、不加"名字:"之类前缀)。从第二行起才是下面的 Style Card。

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
