import { runTool, TOOL_DEFS } from "./tools.js";

// Tools that finish a turn: once one succeeds, the user's intent is done — no
// reason to spend another full Claude round-trip just to fetch a one-line
// confirmation. Read tools (list/read_article/read_style) are NOT here; they
// gather context and the loop must continue after them.
const TERMINAL_TOOLS = new Set(["write_article", "write_style", "publish_wechat", "share_to_community"]);

export function parseAssistant(resp) {
  const content = (resp && resp.content) || [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolUses = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  return { text, toolUses };
}

// Drive Claude with tools until it stops calling them (or maxSteps).
// userContent: string (text-only) or content-block array (e.g. with image blocks).
export async function runAgentLoop({ callClaude, ctx, system, userContent, maxSteps = 8 }) {
  const messages = [{ role: "user", content: userContent }];
  const calledTools = [];
  let finalText = "";
  let hadError = false;
  let steps = 0;
  while (steps < maxSteps) {
    const resp = await callClaude({ system, messages, tools: TOOL_DEFS });
    steps++;
    const { text, toolUses } = parseAssistant(resp);
    messages.push({ role: "assistant", content: resp.content });
    if (!toolUses.length) { finalText = text; break; }
    const results = [];
    let terminalDone = false;
    for (const tu of toolUses) {
      calledTools.push(tu.name);
      const result = await runTool(tu.name, tu.input, ctx);
      if (result && result.error) hadError = true;
      if (result && result.ok === true && TERMINAL_TOOLS.has(tu.name)) terminalDone = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
    // Fast path: a terminal action succeeded → the turn is done. Reply with the
    // model's own pre-tool text instead of burning another round-trip for a
    // confirmation sentence. On error we DON'T short-circuit, so the model gets
    // the failure back and can react.
    if (terminalDone && !hadError) { finalText = text; break; }
  }
  return { calledTools, finalText, steps, hadError };
}
