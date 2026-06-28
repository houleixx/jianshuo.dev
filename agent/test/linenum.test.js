import { describe, it, expect } from "vitest";
import { bodySegments, numberBodyRows, locatorTable } from "../src/linenum.js";

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
