// src/realtime.js — Realtime AI 采访员后端：WebSocket 中转（手机 → 本 worker → OpenAI）。
// 手机连不了 api.openai.com，所以手机只连 /agent/realtime/relay，worker 在边缘用
// OPENAI_API_KEY 连 OpenAI 双向转发（照 asr-proxy proxyVolcAsrWebSocket 先例，无状态 WS 代理）。
// key 完全不上设备。计费在服务端：中转看穿过的 response.done.usage 累加，关闭时扣算力。
import { toSendablePayload } from "./asr-proxy.js";
import { realtimeCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";

// 采访员系统提示词（2026-07-08 改为「默认沉默、只在卡住时插一句」——由提示词驱动，
// 取代原 app 端 5 秒定时逻辑。以后调这段就是调采访员的行为。）
export const INTERVIEWER_INSTRUCTIONS =
  "你是一位老练、极其克制的访谈者。绝大多数时候你只是安静倾听，什么都不说。" +
  "当说话人还在讲述、思考、或只是正常停顿（话还没说完）时，你保持完全沉默，绝不打断、不附和、不接话。" +
  "只有在一种情况下你才开口：说话人明显卡住了、接不下去了、或长时间停顿下来显然需要引导。" +
  "这时你用一句简短、自然、不超过 5 秒的问题，扣住他刚讲到的关键点，帮他更容易接着往下说。" +
  "永远不评论、不总结、不重复他的话、不寒暄、不说客套话。拿不准要不要开口时，宁可继续沉默。";

const PCM24 = { type: "audio/pcm", rate: 24000 };

// 连上后 worker 注入这条 session.update（服务端掌控 instructions/turn_detection，app 不经手）。
// 2026-07-08：改用 semantic_vad + create_response:true——由 OpenAI 语义判断「说话人是否讲完/卡住」
// 后自动触发一次回应，何时开口由模型按 instructions 决定，app 不再做 5 秒定时。
// eagerness:"low" = 更耐心，等说话人真的停下/讲完才判定回合结束，契合「卡住才插话」。
// interrupt_response:true = 配合 app 侧 AEC（全双工）——OpenAI 只听到用户，说话人一开口
// 即可打断 AI（真打断），AI 不会把自己外放的回声当成用户说话去自打断。
export function buildSessionUpdate() {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: INTERVIEWER_INSTRUCTIONS,
      output_modalities: ["audio"],
      audio: {
        input:  { format: PCM24, turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true } },
        output: { format: PCM24, voice: "cedar" },
      },
      reasoning: { effort: "low" },
    },
  };
}

// 出站到 OpenAI 的 WS 请求：CF 出站 WS 要 https:// + Upgrade 头（不能 wss://），key 作 Authorization。
export function buildUpstreamRequest(env) {
  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  headers.set("Authorization", `Bearer ${env.OPENAI_API_KEY}`);
  // 若线上首连被拒，可能需加 headers.set("OpenAI-Beta", "realtime=v1")；核实后回填。
  return new Request("https://api.openai.com/v1/realtime?model=gpt-realtime-2.1", { headers });
}

// 从一条 response.done 事件把 usage 累加进 6 档计数（纯函数，可测）。
// OpenAI realtime usage 结构：response.usage.{input_token_details,output_token_details}，
// cached 拆在 input_token_details.cached_tokens_details。确切字段名以线上核实为准。
export function accumulateUsage(acc, respDone) {
  const u = respDone?.response?.usage;
  if (!u || typeof u !== "object") return acc;
  const idt = u.input_token_details || {};
  const odt = u.output_token_details || {};
  const cached = idt.cached_tokens_details || {};
  const n = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : 0; };
  const cAudio = n(cached.audio_tokens), cText = n(cached.text_tokens);
  acc.audio_in        += Math.max(0, n(idt.audio_tokens) - cAudio);
  acc.audio_in_cached += cAudio;
  acc.text_in         += Math.max(0, n(idt.text_tokens) - cText);
  acc.text_in_cached  += cText;
  acc.audio_out       += n(odt.audio_tokens);
  acc.text_out        += n(odt.text_tokens);
  return acc;
}

export function newUsageAcc() {
  return { audio_in: 0, audio_in_cached: 0, audio_out: 0, text_in: 0, text_in_cached: 0, text_out: 0 };
}

// WS 中转：认证已在调用前（index.js）做完，这里拿到 scope。ctx 用于 waitUntil 计费。
export async function proxyRealtimeWebSocket(request, env, scope, ctx) {
  if (!env.OPENAI_API_KEY) return new Response("realtime unavailable", { status: 503 });

  let upstreamResp;
  try { upstreamResp = await fetch(buildUpstreamRequest(env)); }
  catch (e) { return new Response(String(e?.message || e), { status: 502 }); }

  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    const body = await upstreamResp.text().catch(() => "");
    console.log("[realtime] upstream upgrade failed", upstreamResp.status, body.slice(0, 300));
    return new Response(body || "openai ws upgrade failed", { status: upstreamResp.status || 502 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstream.accept();
  try { server.binaryType = "arraybuffer"; } catch (_) {}
  try { upstream.binaryType = "arraybuffer"; } catch (_) {}

  // 注入采访员配置
  try { upstream.send(JSON.stringify(buildSessionUpdate())); } catch (_) {}

  const usage = newUsageAcc();
  let billed = false;
  const settle = () => {
    if (billed) return; billed = true;
    if (!env.USAGE) return;
    const costUY = realtimeCostUY(usage);
    if (costUY <= 0) return;
    const now = Date.now();
    const detail = { scope, usage };
    ctx?.waitUntil?.((async () => {
      try { await ensureAccount(env.USAGE, scope, now); await debit(env.USAGE, scope, costUY, "realtime", detail, now); } catch (_) {}
    })());
  };

  let closed = false;
  const closeBoth = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    settle();
    try { server.close(code, reason); } catch (_) {}
    try { upstream.close(code, reason); } catch (_) {}
  };

  // 逐帧转发（照 asr-proxy：per-direction promise chain 防乱序 + Blob 归一）。
  const forwarder = (target, watchUsage) => {
    let chain = Promise.resolve();
    return (event) => {
      const data = event.data;
      if (watchUsage && typeof data === "string") {
        try { const o = JSON.parse(data); if (o?.type === "response.done") accumulateUsage(usage, o); } catch (_) {}
      }
      chain = chain.then(async () => {
        try { target.send(await toSendablePayload(data)); }
        catch (_) { closeBoth(1011, "send failed"); }
      });
    };
  };
  server.addEventListener("message", forwarder(upstream, false));
  upstream.addEventListener("message", forwarder(server, true));   // 看 upstream 的 response.done 计费
  server.addEventListener("close", (e) => closeBoth(e.code || 1000, e.reason || "client closed"));
  upstream.addEventListener("close", (e) => closeBoth(e.code || 1000, e.reason || "upstream closed"));
  server.addEventListener("error", () => closeBoth(1011, "client error"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

  console.log("[realtime] relay open", JSON.stringify({ scope, at: Date.now() }));
  return new Response(null, { status: 101, webSocket: client });
}
