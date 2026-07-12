// src/realtime.js — Realtime AI 采访员后端：WebSocket 中转（手机 → 本 worker → OpenAI）。
// 手机连不了 api.openai.com，所以手机只连 /agent/realtime/relay，worker 在边缘用
// OPENAI_API_KEY 连 OpenAI 双向转发（照 asr-proxy proxyVolcAsrWebSocket 先例，无状态 WS 代理）。
// key 完全不上设备。计费在服务端：中转看穿过的 response.done.usage 累加，关闭时扣算力。
import { toSendablePayload } from "./asr-proxy.js";
import { realtimeCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";
import { currentColo } from "./anthropic.js";

// 采访员系统提示词。以后调这段就是调采访员的行为。
// 版本史：07-08 安静版（默认沉默、卡住才插话）→ 07-09 健谈版（用户反馈「不太会
// 聊天」）→ 07-10 健谈+铁律（治「自顾自说个不停」）→ 07-10 用户拍板回滚安静版
// → 07-12 按 OpenAI realtime prompting 指南重构：分节结构、去掉模型执行不了的
// 「停顿三秒」计时指令（那是 semantic_vad 的活）、加 wait_for_user no-op 工具把
// 「这次要不要出声」变成模型每回合的显式决策——治 create_response:true 强迫每次
// VAD 断句都必须说话 vs「保持沉默」的结构性冲突 → 07-12 用户拍板：不问细节
// （数字/时间地点/场景），问宏观（为什么重要/背后逻辑/更大趋势/判断立场）。
// 健谈系全文在 git 史（9da30f9 / 809d503），想再试直接捞。
export const INTERVIEWER_INSTRUCTIONS = `# 角色与目标
你叫 VoiceDrop，是一位老练、克制的中文访谈者。
讲者正在口述一篇文章的素材。你的目标：用最少的话引出讲者更深一层的思考和判断，让最终文章更有观点、更有分量。

# 性格与语气
- 冷静、真诚，像一位资深编辑；不热情过头，不寒暄。
- 每次开口只说一句话，5 秒以内，问完立刻停。

# 何时不说话
- 如果这段音频是：静音、背景噪音、讲者的「嗯」「呃」等思考声、或一句明显没讲完的话——
  调用 wait_for_user，安静等待，之后不要再说任何话。
- 不要说「我在听」「你慢慢想」这类填充语。

# 问题怎么问
- 问宏观的问题，把讲者从眼前的叙述拉高一层：为什么这件事重要、背后的原因或逻辑是什么、
  这说明了什么更大的趋势、他的判断和立场是什么、这对未来意味着什么。
- 不要追问细节：不问数字、时间地点、具体场景这类琐碎信息。
- 每次只问一个问题。
- 不评论、不总结、不重复他的话、不替他补话、不建议他该说什么。
- 变化问法：不连续两次用同样的句式开头。

# 语言
- 始终用中文提问。讲者夹杂英文单词或术语时，不切换语言。

# 听不清时
- 只对听清的内容提问；听不清就问：「刚才那段没听清，能再说一遍吗？」
- 不猜、不脑补漏掉的词；同样的澄清不连续问两次。`;

// no-op 工具：模型判断「这段音频不需要回应」时调用，回合安静结束。没人回这个
// 调用（relay/app 都不处理），模型就一直等下一段人声——这正是想要的行为。
export const WAIT_FOR_USER_TOOL = {
  type: "function",
  name: "wait_for_user",
  description:
    "当最新一段音频不需要回应时调用：静音、背景噪音、讲者的思考声（嗯、呃）、" +
    "没讲完的半句话、或不是对你说的话。调用后本回合安静结束，不要说话。",
  parameters: { type: "object", properties: {}, required: [] },
};

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
      tools: [WAIT_FOR_USER_TOOL],
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

// ── ENAM 中继 fallback ──────────────────────────────────────────────────────
// api.openai.com 和 Anthropic 一样按出口 IP 封地区：worker isolate 落在 HKG 等被封
// colo 时，出站 WS upgrade 直接 403，采访功能整段不可用（同 anthropic.js 的
// geo-block，见该文件头注释）。对策也相同：直连 403 就把同一个客户端 upgrade 请求
// 转进钉在 ENAM（美东）的 RealtimeRelay DO（relay.js），由它在被允许的 colo 连
// OpenAI。直连仍是首选——健康 colo 零额外一跳；本 isolate 吃过一次 403 后转
// relay-first（封锁按 colo，isolate 不挪窝）。带合法 Bearer key 的 upgrade 只会因
// 地区封锁吃 403（key 错是 401、参数错是 400），所以按状态码判定，不赌 body 文案；
// 误判的代价只是多试一次中继。
export const RT_RELAY_LOCATION_HINT = "enam";

let preferRelay = false; // per-isolate：吃过一次 geo-403 = 本 colo 被 OpenAI 封

export function isOpenAIGeoBlock(status) {
  return status === 403;
}

// Test hook: geo state is per-isolate module state.
export function _resetRealtimeGeoState() {
  preferRelay = false;
}

// 把客户端的 WS upgrade 原样转进 ENAM 中继 DO。每个采访一个独立 DO 实例
// （newUniqueId + locationHint，placement 在首次创建时生效）：音频帧每秒几十条，
// 全挤单实例的事件循环会把并发采访拖垮；DO 无状态，用完即弃。scope 走查询参数
// 带过去（认证在 worker 已做完，DO 只信 worker 转来的这条）。
function relayViaDO(request, env, scope) {
  const u = new URL(request.url);
  u.searchParams.set("scope", scope);
  const stub = env.RT_RELAY.get(env.RT_RELAY.newUniqueId(), { locationHint: RT_RELAY_LOCATION_HINT });
  return stub.fetch(new Request(u, request));
}

const isWs = (resp) => Boolean(resp && (resp.webSocket || resp.status === 101));

// 路由入口（index.js 调这个）：直连优先，geo-403 时同一请求内切 ENAM 中继，
// 客户端零感知、连接不失败。
export async function handleRealtimeSession(request, env, scope, ctx, fetchImpl = fetch) {
  if (preferRelay && env.RT_RELAY) {
    // relay-first：本 isolate 已知被封，跳过注定失败的直连。中继挂了再拿直连兜底
    // （最坏再吃一个瞬时 403）；直连成活说明恢复了，翻回 direct-first。
    let relayed;
    try { relayed = await relayViaDO(request, env, scope); }
    catch (e) { relayed = new Response(`relay: ${String(e?.message || e)}`, { status: 502 }); }
    if (isWs(relayed)) return relayed;
    const direct = await proxyRealtimeWebSocket(request, env, scope, ctx, fetchImpl);
    if (isWs(direct)) { preferRelay = false; return direct; }
    return relayed;
  }

  const direct = await proxyRealtimeWebSocket(request, env, scope, ctx, fetchImpl);
  if (isWs(direct) || !env.RT_RELAY || !isOpenAIGeoBlock(direct.status)) return direct;
  preferRelay = true;
  const colo = await currentColo(fetchImpl); // 取证：到底是哪个 colo 被封（对照 llmlog）
  console.log("[realtime] direct OpenAI 403, falling back to ENAM relay DO", JSON.stringify({ scope, colo }));
  try { return await relayViaDO(request, env, scope); }
  catch (e) { return new Response(`relay: ${String(e?.message || e)}`, { status: 502 }); }
}

// health 探针：从「当前位置」（worker 边缘 or 中继 DO）看 api.openai.com 是否可达。
// GET /v1/models 免费且轻量，被封时和 realtime upgrade 一样吃 403。
export async function probeOpenAI(env, fetchImpl = fetch) {
  if (!env.OPENAI_API_KEY) return { ok: false, status: 0, errorText: "no OPENAI_API_KEY" };
  try {
    const r = await fetchImpl("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: r.ok, status: r.status, errorText: r.ok ? undefined : (await r.text().catch(() => "")).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, errorText: String(e?.message || e) };
  }
}

// WS 中转：认证已在调用前（index.js / RealtimeRelay DO）做完，这里拿到 scope。
// ctx 用于 waitUntil 计费。fetchImpl 可注入（测试 + 保持单一出站路径）。
export async function proxyRealtimeWebSocket(request, env, scope, ctx, fetchImpl = fetch) {
  if (!env.OPENAI_API_KEY) return new Response("realtime unavailable", { status: 503 });

  let upstreamResp;
  try { upstreamResp = await fetchImpl(buildUpstreamRequest(env)); }
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
