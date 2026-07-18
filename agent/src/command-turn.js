// 跑一条「库级语音指令」端到端：构造 prompt（用户文风作缓存前缀 + 编号清单 + 指令）、
// 驱动命令工具集的 agent loop、返回结果。破坏性动作以 pending 返回，由 DO 走确认。
import { runAgentLoop } from "./loop.js";
import { toolDefsFor, COMMAND_TOOL_NAMES, COMMAND_TERMINAL } from "./tools.js";
import { readStyleText } from "../../functions/lib/style-store.js";
import { COMMAND_SYSTEM } from "./prompts/command.js";
import { resolveSharedPromptBlock } from "./prompt-share.js";

/// Which article stems a command turn actually touched — from the successful
/// tool runs (tag_article stems / restyle_article stem / merge_articles newStem).
/// Rides on the `updated` WS push so the app can invalidate exactly those rows'
/// caches instead of blind-refreshing into stale titles/tags.
export function affectedStems(toolRuns = []) {
  const out = new Set();
  for (const t of toolRuns) {
    if (!t || !t.ok) continue;
    const a = t.input || {}, r = t.result || {};
    if (Array.isArray(a.stems)) for (const s of a.stems) out.add(String(s));
    if (typeof a.stem === "string") out.add(a.stem);
    if (typeof r.newStem === "string") out.add(r.newStem);
  }
  return [...out];
}

export async function runCommandTurn({ env, scope, token, origin, turnId, instruction, refs = [], callClaude, idemKey, history = [] }) {
  const style = (await readStyleText(env, scope).catch(() => "")) || "";
  const refLines = refs.map((r) => `第${r.n}篇 → stem=${r.stem}｜标题：${r.title}`).join("\n") || "（列表为空）";
  const systemBlocks = [
    { type: "text", text: COMMAND_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: `用户的写作风格（合并/重写时保持）：\n${style || "（未设置）"}`, cache_control: { type: "ephemeral" } },
  ];
  // 指令里报了 7 位分享码 → 追加对应的共享指令块（一次性参考；查无则软备注）。
  const shared = await resolveSharedPromptBlock(env, instruction);
  const userContent = [
    "编号清单（用户此刻在屏幕上看到的顺序，第N篇 ↔ stem）：",
    refLines,
    "",
    "这次的语音指令：",
    instruction,
    ...(shared ? ["", shared.block] : []),
  ].join("\n");

  // ctx 带 callClaude —— merge_articles 需要内部再调一次 Claude 做揉合成。
  // idemKey（稳定的队列行 id）让 merge_articles 派生确定性 stem，重跑不会造第二篇。
  const ctx = { env, scope, token, origin, turnId, callClaude, refs, idemKey };
  // history = 最近几轮 (指令, 回复)，让「把它们合并」「刚才那篇再改回去」这类
  // 指代有着落——和单篇编辑 DO 同一套 buildHistoryMessages 产物。
  const result = await runAgentLoop({
    callClaude, ctx, system: systemBlocks, userContent, history,
    tools: toolDefsFor(COMMAND_TOOL_NAMES), terminalTools: COMMAND_TERMINAL,
  });

  const summary = (result.finalText || "").trim();
  const didAct = (result.calledTools || []).some((n) => COMMAND_TERMINAL.has(n));
  const reply = summary || (result.hadError ? "操作没完成" : (didAct ? "好了" : ""));
  return { ok: !result.hadError, reply, pending: result.pending || [], toolRuns: result.toolRuns || [],
           stems: affectedStems(result.toolRuns), hadError: !!result.hadError };
}
