// Recent-turn memory for the voice editor.
//
// Each edit was otherwise a fresh single-turn request — the article state carried
// forward, but the conversation did not, so the model couldn't resolve back-
// references like "撤销刚才那个", "像上次那样", or "你刚才说的那个". This rebuilds the
// last few turns as REAL conversation messages (user instruction ↔ assistant
// reply) that get prepended to the current turn, so the model sees the actual
// back-and-forth. Historical turns carry only the instruction + reply text (NOT
// the article — the current turn carries the latest article state); kept short
// and capped so a long editing session can't bloat tokens.

export const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_LEN = 400;

function clip(s, maxLen) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
}

// rows: chronological (oldest first) [{instruction, reply}]. Returns an array of
// alternating {role:"user"|"assistant", content:string} messages — the prior
// conversation, ready to prepend before the current user turn. Empty when no
// usable history.
export function buildHistoryMessages(rows, { maxTurns = HISTORY_MAX_TURNS, maxLen = HISTORY_MAX_LEN } = {}) {
  const recent = (rows || []).slice(-maxTurns).filter((r) => r && String(r.instruction || "").trim());
  const msgs = [];
  for (const r of recent) {
    msgs.push({ role: "user", content: clip(r.instruction, maxLen) });
    msgs.push({ role: "assistant", content: clip(r.reply, maxLen) || "（改好了）" });
  }
  return msgs;
}
