// 实时预览的增量提取器:挖矿输出是 {"articles":[{"title":…,"body":…}]} 的 JSON 流,
// App 要看的是纯文本——边流边剥出 title/body 内容,处理转义与跨 chunk 切断。
import { describe, it, expect } from "vitest";
import { PreviewExtractor } from "../src/preview.js";

function feedAll(chunks) {
  const ex = new PreviewExtractor();
  const out = [];
  for (const c of chunks) out.push(...ex.feed(c));
  return out;
}
function joined(events, a, field) {
  return events.filter((e) => e.a === a && e.field === field).map((e) => e.text).join("");
}

describe("PreviewExtractor", () => {
  const DOC = '{"articles":[{"title":"清晨的咖啡","body":"第一段。\\n第二段说\\"你好\\"。"},{"title":"第二篇","body":"正文B"}]}';

  it("整段喂入:按篇/按字段剥出纯文本,转义还原", () => {
    const out = feedAll([DOC]);
    expect(joined(out, 0, "title")).toBe("清晨的咖啡");
    expect(joined(out, 0, "body")).toBe('第一段。\n第二段说"你好"。');
    expect(joined(out, 1, "title")).toBe("第二篇");
    expect(joined(out, 1, "body")).toBe("正文B");
  });

  it("任意字节边界切碎(逐字符喂)结果不变", () => {
    const out = feedAll([...DOC]);   // 一次一个字符,必然切断转义序列
    expect(joined(out, 0, "body")).toBe('第一段。\n第二段说"你好"。');
    expect(joined(out, 1, "body")).toBe("正文B");
  });

  it("markdown 代码围栏与前导废话被忽略,只认第一个 { 开始的 JSON", () => {
    const out = feedAll(["```json\n" + DOC.slice(0, 30), DOC.slice(30) + "\n```"]);
    expect(joined(out, 0, "title")).toBe("清晨的咖啡");
  });

  it("\\uXXXX 转义(含跨 chunk 切断)正确解码", () => {
    const doc = '{"articles":[{"title":"a","body":"\\u4f60\\u597d"}]}';
    const cut = doc.indexOf("u597d") + 2;           // 切在 \\u59|7d 中间
    const out = feedAll([doc.slice(0, cut), doc.slice(cut)]);
    expect(joined(out, 0, "body")).toBe("你好");
  });

  it("questions 等其他字段不外漏", () => {
    const doc = '{"articles":[{"title":"t","body":"b","questions":["不该出现"]}]}';
    const out = feedAll([doc]);
    expect(out.every((e) => e.field === "title" || e.field === "body")).toBe(true);
    expect(out.map((e) => e.text).join("")).not.toContain("不该出现");
  });

  it("reset 后可以处理全新的一份流(force 重试)", () => {
    const ex = new PreviewExtractor();
    ex.feed('{"articles":[{"title":"旧的');
    ex.reset();
    const out = ex.feed('{"articles":[{"title":"新的","body":"b"}]}');
    expect(out.filter((e) => e.field === "title").map((e) => e.text).join("")).toBe("新的");
  });
});

// ── makePreviewPusher:合批 + 保序 + 收尾 ─────────────────────────────────────
import { makePreviewPusher } from "../src/preview.js";

describe("makePreviewPusher", () => {
  it("字符数触发合批,消息保序,done 后必有 preview-done", async () => {
    const sent = [];
    const p = makePreviewPusher(async (obj) => { sent.push(obj); }, { flushMs: 5, flushChars: 10 });
    p.preview.reset();
    p.preview.text('{"articles":[{"title":"这是一个很长很长的标题触发合批","body":"');
    p.preview.text('正文来了');
    await p.done(true);
    expect(sent[0]).toEqual({ type: "preview-reset" });
    expect(sent.at(-1)).toEqual({ type: "preview-done", ok: true });
    const items = sent.filter((m) => m.type === "preview-delta").flatMap((m) => m.items);
    expect(items.filter((e) => e.field === "title").map((e) => e.text).join("")).toBe("这是一个很长很长的标题触发合批");
    expect(items.filter((e) => e.field === "body").map((e) => e.text).join("")).toBe("正文来了");
  });
  it("post 抛错不影响主流程(best-effort)", async () => {
    const p = makePreviewPusher(async () => { throw new Error("DO down"); }, { flushMs: 5, flushChars: 5 });
    p.preview.reset();
    p.preview.text('{"articles":[{"title":"abcdefgh","body":"x"}]}');
    await expect(p.done(true)).resolves.toBeUndefined();
  });
});

// ── EditOpsExtractor:行级编辑工具参数流 → 打字机增量 ─────────────────────────
import { EditOpsExtractor } from "../src/preview.js";

function feedOps(chunks) {
  const ex = new EditOpsExtractor();
  const out = [];
  for (const c of chunks) out.push(...ex.feed(c));
  return out;
}
const OPS = '{"ops":[{"op":"replace_line","line":3,"text":"改后的第三行。"},{"op":"insert_after","line":7,"text":"插入的新段落"},{"op":"delete_lines","lines":[9,10]}]}';

describe("EditOpsExtractor", () => {
  it("整段喂入:replace/insert 的 text 带 op+line 剥出;delete 无文本不出事件", () => {
    const out = feedOps([OPS]);
    const g = (i) => out.filter((e) => e.i === i);
    expect(g(0).map((e) => e.text).join("")).toBe("改后的第三行。");
    expect(g(0)[0].op).toBe("replace_line");
    expect(g(0)[0].line).toBe(3);
    expect(g(1).map((e) => e.text).join("")).toBe("插入的新段落");
    expect(g(1)[0].op).toBe("insert_after");
    expect(g(1)[0].line).toBe(7);
    expect(out.every((e) => e.i !== 2)).toBe(true);
  });
  it("逐字符切碎结果不变(转义/数字/跨界安全)", () => {
    const out = feedOps([...OPS]);
    expect(out.filter((e) => e.i === 0).map((e) => e.text).join("")).toBe("改后的第三行。");
    expect(out.filter((e) => e.i === 1)[0].line).toBe(7);
  });
  it("set_title 的 title 字段也出事件(line=null)", () => {
    const doc = '{"ops":[{"op":"set_title","title":"新标题"}]}';
    const out = feedOps([doc]);
    expect(out.map((e) => e.text).join("")).toBe("新标题");
    expect(out[0].op).toBe("set_title");
    expect(out[0].line).toBe(null);
  });
});
