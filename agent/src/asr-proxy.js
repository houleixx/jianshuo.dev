// CF Workers outbound WebSocket requires an https:// URL + `Upgrade: websocket`
// header — a wss:// scheme makes fetch() throw "Fetch API cannot load".
import { asrCorpus } from "./asr-hotwords.js";

const VOLC_ASR_ENDPOINT = "https://openspeech.bytedance.com/api/v3/sauc/bigmodel";
const VOLC_ASR_RESOURCE_ID = "volc.bigasr.sauc.duration";

export function buildVolcAsrRequest(_clientRequest, env) {
  if (!env.VOLC_ASR_APPID || !env.VOLC_ASR_ACCESS_TOKEN) {
    throw new Error("VOLC_ASR_APPID or VOLC_ASR_ACCESS_TOKEN is not configured");
  }

  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  headers.set("X-Api-App-Key", env.VOLC_ASR_APPID);
  headers.set("X-Api-Access-Key", env.VOLC_ASR_ACCESS_TOKEN);
  headers.set("X-Api-Resource-Id", VOLC_ASR_RESOURCE_ID);
  headers.set("X-Api-Connect-Id", crypto.randomUUID());

  return new Request(VOLC_ASR_ENDPOINT, { headers });
}

// CF Workers may deliver a binary WS frame's `event.data` as a Blob. Passing a
// Blob straight to `WebSocket.send()` coerces it to the STRING "[object Blob]",
// silently corrupting every binary frame in both directions — the audio never
// reaches Volcengine (so it returns nothing) and results never reach the app.
// Normalize a Blob back to its bytes; pass strings and ArrayBuffers through.
export async function toSendablePayload(data) {
  if (data && typeof data !== "string" && typeof data.arrayBuffer === "function") {
    return await data.arrayBuffer();
  }
  return data;
}

async function pipeBytes(bytes, transform) {
  const resp = new Response(new Blob([bytes]).stream().pipeThrough(transform));
  return new Uint8Array(await resp.arrayBuffer());
}
const gzipBytes   = (b) => pipeBytes(b, new CompressionStream("gzip"));
const gunzipBytes = (b) => pipeBytes(b, new DecompressionStream("gzip"));

// Inject the server-side hotword list into the sauc "full client request" frame
// (the app builds this frame — VoiceDropApp/VolcASRProtocol.swift — and doesn't
// know about hotwords; keeping the list here means every client gets it with no
// app release). Frame layout: 4-byte header | 4-byte sequence (when flags≠0) |
// 4-byte BE payload size | payload (JSON, gzip when the compression nibble says so).
// Audio-only frames (message type 0b0010) return early on the type check, so this
// runs on every client→upstream frame at negligible cost. Any parse/format surprise
// falls through to forwarding the original frame untouched — never break the stream.
export async function injectAsrHotwords(data) {
  try {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 12) return data;
    const buf = new Uint8Array(data);
    const headerSize    = (buf[0] & 0x0f) * 4;
    const messageType   = (buf[1] >> 4) & 0x0f;
    const flags         = buf[1] & 0x0f;
    const serialization = (buf[2] >> 4) & 0x0f;
    const compression   = buf[2] & 0x0f;
    if (messageType !== 0b0001 || serialization !== 0b0001) return data; // not a JSON full client request
    let off = headerSize;
    if (flags & 0x01 || flags & 0x02) off += 4; // sequence — same test as the app's parser
    const size = new DataView(data, off, 4).getUint32(0);
    off += 4;
    if (off + size > buf.byteLength) return data;
    let payload = buf.slice(off, off + size);
    if (compression === 0b0001) payload = await gunzipBytes(payload);
    const req = JSON.parse(new TextDecoder().decode(payload));
    req.request = req.request || {};
    req.request.corpus = { ...(req.request.corpus || {}), ...asrCorpus() };
    let out = new TextEncoder().encode(JSON.stringify(req));
    if (compression === 0b0001) out = await gzipBytes(out);
    const frame = new Uint8Array(off + out.byteLength);
    frame.set(buf.subarray(0, off - 4), 0);
    new DataView(frame.buffer).setUint32(off - 4, out.byteLength);
    frame.set(out, off);
    return frame.buffer;
  } catch (_) {
    return data;
  }
}

export async function proxyVolcAsrWebSocket(request, env) {
  let upstreamResp;
  try {
    upstreamResp = await fetch(buildVolcAsrRequest(request, env));
  } catch (e) {
    return new Response(String(e?.message || e), { status: 500 });
  }

  const upstream = upstreamResp.webSocket;
  if (!upstream) {
    const body = await upstreamResp.text().catch(() => "");
    return new Response(body || "Volc ASR websocket upgrade failed", {
      status: upstreamResp.status || 502,
    });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstream.accept();
  // Prefer ArrayBuffer delivery so binary frames never arrive as Blob; the
  // forwarder below still normalizes defensively in case it's ignored.
  try { server.binaryType = "arraybuffer"; } catch (_) {}
  try { upstream.binaryType = "arraybuffer"; } catch (_) {}

  let closed = false;
  const closeBoth = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason); } catch (_) {}
    try { upstream.close(code, reason); } catch (_) {}
  };

  // Forward messages through a per-direction promise chain so that the async
  // Blob→ArrayBuffer normalization can't reorder frames (audio order matters).
  const forwarder = (target, failReason, transform) => {
    let chain = Promise.resolve();
    return (event) => {
      const data = event.data;
      chain = chain.then(async () => {
        try {
          let payload = await toSendablePayload(data);
          if (transform) payload = await transform(payload);
          target.send(payload);
        }
        catch (_) { closeBoth(1011, failReason); }
      });
    };
  };
  server.addEventListener("message", forwarder(upstream, "upstream send failed", injectAsrHotwords));
  upstream.addEventListener("message", forwarder(server, "client send failed"));
  server.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "client closed"));
  upstream.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "upstream closed"));
  server.addEventListener("error", () => closeBoth(1011, "client error"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

  return new Response(null, { status: 101, webSocket: client });
}
