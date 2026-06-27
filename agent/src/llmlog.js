// Append one LLM-interaction record to R2 under llmlogs/<date>/<id>.json, so the
// admin console (voicedrop/admin/llm.html) can replay exactly what was sent and
// received. Shared by the editor agent (index.js) and the miner (miner.js) —
// single source of truth. Best-effort: a logging failure must never break the
// actual work. Callers pass `source` ("agent" | "mine") in the record.
export async function writeLlmLog(env, rec) {
  try {
    const ts = rec.ts || Date.now();
    const rid = `${ts}-${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
    await env.FILES.put(
      `llmlogs/${day}/${rid}.json`,
      JSON.stringify({ id: rid, ts, ...rec }),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch (_) {
    // swallow — logging must never interrupt the actual work
  }
}
