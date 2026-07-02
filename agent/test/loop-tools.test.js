import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { register } from "../src/tools.js";

// Throwaway tool, registered only for this test file.
register(
  { name: "stage_thing", description: "d", input_schema: { type: "object", properties: {} } },
  async () => ({ ok: true, pending: { action: "thing" } })
);

describe("runAgentLoop tools/terminalTools/pending", () => {
  it("只把传入的 tools 交给 callClaude，并透传 pending", async () => {
    let sawTools = null;
    const call = async ({ tools }) => {
      sawTools = tools;
      return { content: [
        { type: "text", text: "好的" },
        { type: "tool_use", id: "t1", name: "stage_thing", input: { x: 1 } },
      ] };
    };
    const { pending } = await runAgentLoop({
      callClaude: call, ctx: {}, system: "s", userContent: "u",
      tools: [{ name: "stage_thing", description: "d", input_schema: { type: "object", properties: {} } }],
      terminalTools: new Set(["stage_thing"]),
    });
    expect(sawTools.map((t) => t.name)).toEqual(["stage_thing"]);
    expect(pending).toEqual([{ action: "thing" }]);
  });
});
