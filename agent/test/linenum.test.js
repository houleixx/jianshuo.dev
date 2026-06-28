import { describe, it, expect } from "vitest";
import { bodySegments, numberBodyRows, locatorTable, applyArticleEdits, rowsToBody } from "../src/linenum.js";

// These assertions encode the SHARED numbering contract with the iOS app
// (RecordingDetailView.bodyRows + ArticleBody.segments). If this changes, the
// Swift side must change in lockstep or the locator the model reads drifts from
// the number the user sees.

describe("numberBodyRows", () => {
  it("numbers plain paragraphs (blank-line separated) 1..N", () => {
    const rows = numberBodyRows("段落一\n\n段落二\n\n段落三");
    expect(rows).toEqual([
      { n: 1, kind: "text", text: "段落一" },
      { n: 2, kind: "text", text: "段落二" },
      { n: 3, kind: "text", text: "段落三" },
    ]);
  });

  it("an image consumes a continuous line number AND gets its own 图M", () => {
    const body = "开头\n\n[[photo:photos/a.jpg]]\n\n中间\n\n[[photo:photos/b.jpg]]\n\n结尾";
    const rows = numberBodyRows(body);
    expect(rows).toEqual([
      { n: 1, kind: "text", text: "开头" },
      { n: 2, kind: "photo", imgNo: 1, token: "photos/a.jpg" },
      { n: 3, kind: "text", text: "中间" },
      { n: 4, kind: "photo", imgNo: 2, token: "photos/b.jpg" },
      { n: 5, kind: "text", text: "结尾" },
    ]);
  });

  it("line numbers accumulate ACROSS images — the paragraph after an image shifts", () => {
    // The whole point: 中间 is the 3rd line, not the 2nd, because the image is line 2.
    const rows = numberBodyRows("开头\n[[photo:x.jpg]]\n中间");
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.kind === "text" && r.text === "中间").n).toBe(3);
  });

  it("the miner's own-line marker (leading spaces) counts as exactly one line", () => {
    // miner.js writes `  [[photo:key]]` joined by \n — must not split into extra lines.
    const rows = numberBodyRows("一\n  [[photo:k.jpg]]\n二");
    expect(rows.map((r) => `${r.n}:${r.kind}`)).toEqual(["1:text", "2:photo", "3:text"]);
  });

  it("drops empty lines and trims, like the iOS row builder", () => {
    const rows = numberBodyRows("  甲  \n\n\n   \n乙");
    expect(rows).toEqual([
      { n: 1, kind: "text", text: "甲" },
      { n: 2, kind: "text", text: "乙" },
    ]);
  });

  it("handles a body with no markers and an empty body", () => {
    expect(numberBodyRows("只有一行").map((r) => r.n)).toEqual([1]);
    expect(numberBodyRows("")).toEqual([]);
  });
});

describe("bodySegments", () => {
  it("returns the whole body as one text segment when there are no markers", () => {
    expect(bodySegments("abc")).toEqual([{ kind: "text", text: "abc" }]);
  });
});

describe("locatorTable", () => {
  it("renders a line for every row, marking image rows with both 第N行 and 图M", () => {
    const body = "开头一句\n\n[[photo:photos/a.jpg]]\n\n结尾一句";
    expect(locatorTable(body)).toBe(
      "第1行：开头一句\n第2行 = 图1：[[photo:photos/a.jpg]]\n第3行：结尾一句"
    );
  });

  it("caps long previews", () => {
    const long = "x".repeat(100);
    const line = locatorTable(long).split("\n")[0];
    expect(line.startsWith("第1行：")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(80);
  });
});

describe("rowsToBody", () => {
  it("round-trips numbered rows back to a blank-line-separated body", () => {
    const body = "开头\n\n[[photo:photos/a.jpg]]\n\n结尾";
    expect(rowsToBody(numberBodyRows(body))).toBe(body);
  });
});

describe("applyArticleEdits", () => {
  it("deletes a text line by 第N行", () => {
    expect(applyArticleEdits("一\n\n二\n\n三", [{ op: "delete_lines", lines: [2] }]).body).toBe("一\n\n三");
  });

  it("deletes an image by its 第N行, leaving the text rows", () => {
    const body = "开头\n\n[[photo:p/a.jpg]]\n\n结尾";
    expect(applyArticleEdits(body, [{ op: "delete_lines", lines: [2] }]).body).toBe("开头\n\n结尾");
  });

  it("replaces just one text line", () => {
    expect(applyArticleEdits("一\n\n二\n\n三", [{ op: "replace_line", line: 2, text: "新二" }]).body).toBe("一\n\n新二\n\n三");
  });

  it("refuses to replace a photo row (would drop the marker)", () => {
    expect(applyArticleEdits("a\n\n[[photo:x.jpg]]", [{ op: "replace_line", line: 2, text: "y" }]))
      .toEqual({ error: "cannot_replace_photo", line: 2 });
  });

  it("inserts after a line, and prepends with line 0", () => {
    const r = applyArticleEdits("一\n\n二", [
      { op: "insert_after", line: 1, text: "1.5" },
      { op: "insert_after", line: 0, text: "0" },
    ]);
    expect(r.body).toBe("0\n\n一\n\n1.5\n\n二");
  });

  it("errors (no mutation) when a referenced line doesn't exist", () => {
    expect(applyArticleEdits("一", [{ op: "delete_lines", lines: [9] }])).toEqual({ error: "line_not_found", line: 9 });
  });

  it("preserves a photo key verbatim across an unrelated text edit", () => {
    const body = "开头\n\n[[photo:photos/2026/x.jpg]]\n\n结尾";
    expect(applyArticleEdits(body, [{ op: "replace_line", line: 1, text: "新开头" }]).body)
      .toBe("新开头\n\n[[photo:photos/2026/x.jpg]]\n\n结尾");
  });

  it("resolves a batch of ops against the ORIGINAL numbering", () => {
    const r = applyArticleEdits("一\n\n二\n\n三", [
      { op: "delete_lines", lines: [1] },
      { op: "replace_line", line: 3, text: "新三" },
    ]);
    expect(r.body).toBe("二\n\n新三");
  });

  it("rejects unknown / malformed ops", () => {
    expect(applyArticleEdits("一", [{ op: "frobnicate" }])).toEqual({ error: "unknown_op", op: "frobnicate" });
    expect(applyArticleEdits("一", [null])).toEqual({ error: "bad_op" });
  });
});
