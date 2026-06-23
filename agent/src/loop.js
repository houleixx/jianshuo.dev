import { runTool, TOOL_DEFS } from "./tools.js";

export function parseAssistant(resp) {
  const content = (resp && resp.content) || [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolUses = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  return { text, toolUses };
}

// Drive Claude with tools until it stops calling them (or maxSteps).
export async function runAgentLoop({ callClaude, ctx, system, userText, maxSteps = 8 }) {
  const messages = [{ role: "user", content: userText }];
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
    for (const tu of toolUses) {
      calledTools.push(tu.name);
      const result = await runTool(tu.name, tu.input, ctx);
      if (result && result.error) hadError = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }
  return { calledTools, finalText, steps, hadError };
}
