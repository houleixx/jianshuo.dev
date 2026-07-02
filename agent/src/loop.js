import { runTool, TOOL_DEFS } from "./tools.js";

// Tools that finish a turn: once one succeeds, the user's intent is done — no
// reason to spend another full Claude round-trip just to fetch a one-line
// confirmation. Read tools (list/read_article/read_style) are NOT here; they
// gather context and the loop must continue after them.
const TERMINAL_TOOLS = new Set(["edit_current_article", "write_article", "write_style", "publish_wechat", "share_to_community"]);

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
export async function runAgentLoop({ callClaude, ctx, system, userContent, history = [], maxSteps = 8, tools = TOOL_DEFS, terminalTools = TERMINAL_TOOLS }) {
  // `history` = prior conversation turns (alternating user/assistant text messages)
  // prepended so the model has cross-turn context; the current turn follows.
  const messages = [...history, { role: "user", content: userContent }];
  const calledTools = [];
  // Every tool the model actually ran, with its input AND result. The terminal
  // short-circuit (below) ends the turn WITHOUT another Claude call, so a
  // terminal tool's result never lands in any logged request — this is the only
  // place it's captured, so the admin can show what each instruction actually did.
  const toolRuns = [];
  const pending = []; // 工具暂存、待客户端确认的破坏性动作
  let finalText = "";
  let hadError = false;
  let steps = 0;
  while (steps < maxSteps) {
    const resp = await callClaude({ system, messages, tools });
    steps++;
    const { text, toolUses } = parseAssistant(resp);
    messages.push({ role: "assistant", content: resp.content });
    if (!toolUses.length) { finalText = text; break; }
    const results = [];
    let terminalDone = false;
    for (const tu of toolUses) {
      calledTools.push(tu.name);
      const result = await runTool(tu.name, tu.input, ctx);
      toolRuns.push({ step: steps - 1, name: tu.name, input: tu.input, result, ok: !(result && result.error) });
      if (result && result.error) hadError = true;
      if (result && result.pending) pending.push(result.pending);
      if (result && result.ok === true && terminalTools.has(tu.name)) terminalDone = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
    // Fast path: a terminal action succeeded → the turn is done. Reply with the
    // model's own pre-tool text instead of burning another round-trip for a
    // confirmation sentence. On error we DON'T short-circuit, so the model gets
    // the failure back and can react.
    if (terminalDone && !hadError) { finalText = text; break; }
  }
  return { calledTools, toolRuns, finalText, steps, hadError, pending };
}
