// src/realtime.js — Realtime AI 采访员后端：mint 临时凭证 + usage 计费。
// OPENAI_API_KEY 只在 worker，向 OpenAI mint 短时 client_secret 下发给 app。
import { bearerToken } from "../../functions/lib/auth.js";
import { resolveScope } from "./index.js";
import { realtimeCostUY, uyToSuanli } from "./usage.js";
import { ensureAccount, debit, balanceUY } from "./usage_store.js";

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const r1 = (n) => Math.round(n * 10) / 10;

// 采访员系统提示词（spec D）。app 侧只在 ≥5s 停顿+限流时才 response.create。
export const INTERVIEWER_INSTRUCTIONS =
  "你是一位老练的媒体采访者。你认真听、真正理解对方说的核心。只用一句话、不超过 5 秒的简短追问，" +
  "扣住他刚说的关键点，目的是帮他更容易接着往下说。绝不打断、不评论、不总结、不寒暄、不重复他的话。语气自然、克制。";

// mint 请求体。turn_detection 用 server_vad 但 create_response:false——只借它的
// speech_started/stopped 事件，何时发 response.create 由 app 控制（限流）。
// 注意：/v1/realtime/client_secrets 的确切嵌套随 OpenAI 演进，部署前用真 curl 核实（见 plan Task 4）。
export function buildSessionConfig() {
  return {
    model: "gpt-realtime-2.1",
    instructions: INTERVIEWER_INSTRUCTIONS,
    output_modalities: ["audio"],
    audio: {
      input:  { format: "pcm16", turn_detection: { type: "server_vad", silence_duration_ms: 500, create_response: false, interrupt_response: false } },
      output: { format: "pcm16", voice: "cedar" },
    },
    reasoning: { effort: "low" },
  };
}

export async function handleRealtimeRoute(url, request, env) {
  if (!url.pathname.startsWith("/agent/realtime/")) return null;
  const tok = bearerToken(request);
  const scope = await resolveScope(tok, env);
  if (!scope) return J({ error: "unauthorized" }, 401);

  if (url.pathname === "/agent/realtime/session" && request.method === "POST") {
    if (!env.OPENAI_API_KEY) return J({ error: "realtime unavailable" }, 503);
    let resp;
    try {
      resp = await globalThis.fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildSessionConfig()),
      });
    } catch { resp = null; }
    if (!resp || !resp.ok) return J({ error: "openai-unavailable", status: resp?.status || 0 }, 502);
    const data = await resp.json();
    return J({ client_secret: data.client_secret ?? null, expires_at: data.expires_at ?? null, session_id: data.id ?? null });
  }

  if (url.pathname === "/agent/realtime/usage" && request.method === "POST") {
    let body; try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body.usage !== "object" || !body.usage) return J({ error: "expected {usage}" }, 400);
    if (!env.USAGE) return J({ ok: true, degraded: true });
    const now = Date.now();
    await ensureAccount(env.USAGE, scope, now);
    const costUY = realtimeCostUY(body.usage);
    const detail = { session_id: body.session_id || null, usage: body.usage };
    await debit(env.USAGE, scope, costUY, "realtime", detail, now); // debit 对 <=0 自动早返回；无桶时开负 overdraft
    const bal = await balanceUY(env.USAGE, scope, now);
    return J({ ok: true, charged_suanli: r1(uyToSuanli(costUY)), balance_suanli: r1(uyToSuanli(bal)) });
  }

  return J({ error: "not found" }, 404);
}
