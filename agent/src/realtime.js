// src/realtime.js — Realtime AI 采访员后端：WebSocket 中转（手机 → 本 worker → OpenAI）。
// 手机连不了 api.openai.com，所以手机只连 /agent/realtime/relay，worker 在边缘用
// OPENAI_API_KEY 连 OpenAI 双向转发（照 asr-proxy proxyVolcAsrWebSocket 先例，无状态 WS 代理）。
// key 完全不上设备。计费在服务端：中转看穿过的 response.done.usage 累加，关闭时扣算力。
import { toSendablePayload } from "./asr-proxy.js";
import { realtimeCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";

// 采访员系统提示词。以后调这段就是调采访员的行为。
// 2026-07-09 改版：从「默认沉默、卡住才插话」改为「健谈的陪写者」——用户反馈旧版
// 「不太会聊天」。
// 2026-07-10 再改：用户反馈「采访者自顾自说个不停」——生产 ledger 多段采访
// audio_out 达 audio_in 的 3~10 倍。保留共情+提问的陪写风格，但改三处：
// 「他一说完你就要接住，不让对话冷场」删掉（这是在命令模型填满每个沉默）；
// 加「绝不连续发言」铁律；加「听到回声/噪音保持沉默」。
// （历版全文都在 git 史，想回退直接 revert 本段。）
export const INTERVIEWER_INSTRUCTIONS =
  "你叫 VoiceDrop，是一位温暖的采访者，正在陪讲者一起完成一篇文章。" +
  "主角永远是讲者：他说十句，你才说一句。你的目的是让他越说越多、越说越深。" +
  "你要边听边推测：他这篇文章想写什么？已经讲出了哪些材料？还缺什么？" +
  "然后用提问把缺的部分引出来——细节、例子、数字、当时的场景、他的感受和看法。" +
  "讲者告一段落时，你先用半句话共情或呼应他刚说的，让他感到被听懂，" +
  "再顺势抛出一个能打开思路的问题——可以追问背后的为什么，也可以换一个角度。" +
  "铁律一：每次发言最多两句话、不超过 5 秒，问完立刻停下。" +
  "铁律二：绝不连续发言——你说完一次后必须沉默，等讲者说出新的内容才能再开口；" +
  "他不说话，你也不说，沉默多久都等着。" +
  "铁律三：讲者还在讲述或思考时不要打断；只听到回声、背景噪音或没听清时，保持沉默。" +
  "不长篇评论，不总结全文，不替他说内容，不说教，不客套。";

const PCM24 = { type: "audio/pcm", rate: 24000 };
// 上行改 G.711 μ-law（8 kHz，1 字节/样本）：北京用户到 Cloudflare 的跨境链路扛不住
// 24kHz PCM16 那 ~600kbps 的持续上行（几秒就断），μ-law 把上行压到 ~85kbps，电话音质
// 对「听懂内容 + semantic_vad 判断卡没卡住」完全够用。下行（AI 声音）保持 24k PCM 不变。
const PCMU = { type: "audio/pcmu" };

// 连上后 worker 注入这条 session.update（服务端掌控 instructions/turn_detection，app 不经手）。
// 2026-07-08：改用 semantic_vad + create_response:true——由 OpenAI 语义判断「说话人是否讲完/卡住」
// 后自动触发一次回应，何时开口由模型按 instructions 决定，app 不再做 5 秒定时。
// eagerness:"medium"（2026-07-08 从 low 上调）= 停顿约几秒即判定回合结束，配合提示词
// 「停顿超过三秒就提一个问题」；low 太佛系，讲者停半天 AI 也不接。
// interrupt_response:false = AEC 在设备上把 tap 弄哑（tap 0）故弃用，改 app 侧半双工
// （AI 说话期间暂停发麦克风）防回声自打断；无真打断，靠半双工避免 AI 说一半被自己掐断。
// inputFormat 由客户端在 WS URL 上声明（?fmt=pcmu）：新 app 发 μ-law，旧 TestFlight
// 包没带参数就保持 PCM24——避免「relay 已切 μ-law、旧包还在发 PCM16 → OpenAI 全听成
// 噪音」的升级窗口。等所有测试机都到新包后可把默认翻成 PCMU。
export function buildSessionUpdate(inputFormat = PCM24) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: INTERVIEWER_INSTRUCTIONS,
      // 2026-07-10：semantic_vad 自动触发的回应不带 app 那个 response.create 的 120
      // 上限（auto 模式下 app 从不发 response.create），没有 session 级上限就是无限长
      // ——「自顾自说个不停」的结构性一半。300 ≈ 最多 10 秒左右的话，正常「共情半句+
      // 一个问题」远用不满，纯粹是独白的保险丝。
      max_output_tokens: 300,
      output_modalities: ["audio"],
      audio: {
        input:  { format: inputFormat, turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: false } },
        output: { format: PCM24, voice: "cedar" },
      },
      reasoning: { effort: "low" },
    },
  };
}

export const REALTIME_FORMATS = { PCM24, PCMU };

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
  const fmt = (() => { try { return new URL(request.url).searchParams.get("fmt"); } catch (_) { return null; } })();
  try { upstream.send(JSON.stringify(buildSessionUpdate(fmt === "pcmu" ? PCMU : PCM24))); } catch (_) {}

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
  const openedAt = Date.now();
  // source 标注断开是哪一段发起的：client=手机↔CF 段（跨境链路问题在这里现形）、
  // openai=CF↔OpenAI 段、relay=转发失败。北京用户「几秒就断」的取证靠这行日志。
  const closeBoth = (code = 1000, reason = "closed", source = "relay") => {
    if (closed) return;
    closed = true;
    console.log("[realtime] relay close", JSON.stringify({
      scope, source, code, reason: String(reason).slice(0, 120),
      aliveMs: Date.now() - openedAt, usage,
    }));
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
  server.addEventListener("close", (e) => closeBoth(e.code || 1000, e.reason || "client closed", "client"));
  upstream.addEventListener("close", (e) => closeBoth(e.code || 1000, e.reason || "upstream closed", "openai"));
  server.addEventListener("error", () => closeBoth(1011, "client error", "client"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error", "openai"));

  console.log("[realtime] relay open", JSON.stringify({ scope, at: Date.now() }));
  return new Response(null, { status: 101, webSocket: client });
}
