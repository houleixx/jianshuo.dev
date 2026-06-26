import { describe, it, expect } from "vitest";
import { buildHistoryMessages, HISTORY_MAX_TURNS } from "../src/history.js";

describe("buildHistoryMessages", () => {
  it("no rows → empty array", () => {
    expect(buildHistoryMessages([])).toEqual([]);
    expect(buildHistoryMessages(undefined)).toEqual([]);
  });

  it("builds alternating user/assistant turns in order", () => {
    const msgs = buildHistoryMessages([
      { instruction: "把第3行改简洁", reply: "改好了" },
      { instruction: "再简洁点", reply: "好了" },
    ]);
    expect(msgs).toEqual([
      { role: "user", content: "把第3行改简洁" },
      { role: "assistant", content: "改好了" },
      { role: "user", content: "再简洁点" },
      { role: "assistant", content: "好了" },
    ]);
  });

  it("ends on an assistant turn so the current user turn can follow (valid alternation)", () => {
    const msgs = buildHistoryMessages([{ instruction: "改标题", reply: "改好了" }]);
    expect(msgs[0].role).toBe("user");
    expect(msgs[msgs.length - 1].role).toBe("assistant");
  });

  it("empty reply → placeholder so no assistant message is blank", () => {
    const msgs = buildHistoryMessages([{ instruction: "改一下", reply: "" }]);
    expect(msgs[1]).toEqual({ role: "assistant", content: "（改好了）" });
  });

  it("drops rows with a blank instruction", () => {
    const msgs = buildHistoryMessages([
      { instruction: "", reply: "x" },
      { instruction: "改标题", reply: "改好了" },
    ]);
    expect(msgs).toEqual([
      { role: "user", content: "改标题" },
      { role: "assistant", content: "改好了" },
    ]);
  });

  it("keeps only the most recent maxTurns", () => {
    const rows = Array.from({ length: HISTORY_MAX_TURNS + 3 }, (_, i) => ({ instruction: `i${i}`, reply: `r${i}` }));
    const msgs = buildHistoryMessages(rows);
    expect(msgs).toHaveLength(HISTORY_MAX_TURNS * 2);
    expect(msgs[0].content).toBe("i3"); // first 3 dropped
  });

  it("clips overly long instruction/reply", () => {
    const long = "x".repeat(1000);
    const msgs = buildHistoryMessages([{ instruction: long, reply: long }], { maxLen: 50 });
    expect(msgs[0].content.length).toBe(51); // 50 + ellipsis
    expect(msgs[0].content.endsWith("…")).toBe(true);
  });
});
