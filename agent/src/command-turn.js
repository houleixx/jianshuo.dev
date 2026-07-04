// 跑一条「库级语音指令」端到端：构造 prompt（用户文风作缓存前缀 + 编号清单 + 指令）、
// 驱动命令工具集的 agent loop、返回结果。破坏性动作以 pending 返回，由 DO 走确认。
import { runAgentLoop } from "./loop.js";
import { toolDefsFor, COMMAND_TOOL_NAMES, COMMAND_TERMINAL } from "./tools.js";
import { readStyleText } from "../../functions/lib/style-store.js";

const COMMAND_SYSTEM = [
  "你是 VoiceDrop 的语音指挥助手。用户在「我的录音」列表长按红键、对着编号说一句指令，",
  "你要理解意图并用工具执行。列表里每篇文章都有一个编号（第N篇）——用户说「第N篇/第③篇」时，",
  "严格按下面给出的『编号清单』把编号映射到对应的 stem，再调用工具。不确定指代时，用文字回问，别乱猜、别动数据。",
  "合并用 merge_articles（另存新篇、原文保留）；删除用 delete_article（会等用户确认）；",
  "换风格重写用 restyle_article；归类/打标签用 tag_article（去掉标签则加 remove:true）；调整文风用 write_style。只做用户要求的操作。",
].join("");

export async function runCommandTurn({ env, scope, token, origin, turnId, instruction, refs = [], callClaude, idemKey }) {
  const style = (await readStyleText(env, `${scope}CLAUDE.json`, `${scope}CLAUDE.md`).catch(() => "")) || "";
  const refLines = refs.map((r) => `第${r.n}篇 → stem=${r.stem}｜标题：${r.title}`).join("\n") || "（列表为空）";
  const systemBlocks = [
    { type: "text", text: COMMAND_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: `用户的写作风格（合并/重写时保持）：\n${style || "（未设置）"}`, cache_control: { type: "ephemeral" } },
  ];
  const userContent = [
    "编号清单（用户此刻在屏幕上看到的顺序，第N篇 ↔ stem）：",
    refLines,
    "",
    "这次的语音指令：",
    instruction,
  ].join("\n");

  // ctx 带 callClaude —— merge_articles 需要内部再调一次 Claude 做揉合成。
  // idemKey（稳定的队列行 id）让 merge_articles 派生确定性 stem，重跑不会造第二篇。
  const ctx = { env, scope, token, origin, turnId, callClaude, refs, idemKey };
  const result = await runAgentLoop({
    callClaude, ctx, system: systemBlocks, userContent,
    tools: toolDefsFor(COMMAND_TOOL_NAMES), terminalTools: COMMAND_TERMINAL,
  });

  const summary = (result.finalText || "").trim();
  const didAct = (result.calledTools || []).some((n) => COMMAND_TERMINAL.has(n));
  const reply = summary || (result.hadError ? "操作没完成" : (didAct ? "好了" : ""));
  return { ok: !result.hadError, reply, pending: result.pending || [], toolRuns: result.toolRuns || [], hadError: !!result.hadError };
}
