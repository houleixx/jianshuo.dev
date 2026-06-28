// CF Workers outbound WebSocket requires an https:// URL + `Upgrade: websocket`
// header — a wss:// scheme makes fetch() throw "Fetch API cannot load".
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
  const forwarder = (target, failReason) => {
    let chain = Promise.resolve();
    return (event) => {
      const data = event.data;
      chain = chain.then(async () => {
        try { target.send(await toSendablePayload(data)); }
        catch (_) { closeBoth(1011, failReason); }
      });
    };
  };
  server.addEventListener("message", forwarder(upstream, "upstream send failed"));
  upstream.addEventListener("message", forwarder(server, "client send failed"));
  server.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "client closed"));
  upstream.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "upstream closed"));
  server.addEventListener("error", () => closeBoth(1011, "client error"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

  return new Response(null, { status: 101, webSocket: client });
}
