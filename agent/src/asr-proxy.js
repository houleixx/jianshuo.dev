const VOLC_ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
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

  let closed = false;
  const closeBoth = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason); } catch (_) {}
    try { upstream.close(code, reason); } catch (_) {}
  };

  server.addEventListener("message", (event) => {
    try { upstream.send(event.data); } catch (_) { closeBoth(1011, "upstream send failed"); }
  });
  upstream.addEventListener("message", (event) => {
    try { server.send(event.data); } catch (_) { closeBoth(1011, "client send failed"); }
  });
  server.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "client closed"));
  upstream.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "upstream closed"));
  server.addEventListener("error", () => closeBoth(1011, "client error"));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));

  return new Response(null, { status: 101, webSocket: client });
}
