import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

// POST /files/api/wechat-validate — the app's pre-save credential check. The
// route only forwards {appid,secret} to the relay's /validate and passes the
// relay's verdict through; these tests stub global fetch as the relay.
function ctx(body, envExtra = {}) {
  const env = {
    ...fakeEnv(),
    FILES_TOKEN: "admin",
    SESSION_SECRET: "secret",
    WECHAT_RELAY_URL: "https://relay.example/publish",
    WECHAT_RELAY_SECRET: "rs",
    ...envExtra,
  };
  const request = new Request("https://jianshuo.dev/files/api/wechat-validate", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: ["wechat-validate"] } };
}

afterEach(() => vi.unstubAllGlobals());

describe("POST wechat-validate", () => {
  it("forwards creds to the relay's /validate and passes ok:true through", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await onRequest(ctx({ appid: "wx1", secret: "s1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example/validate");
    expect(calls[0].init.headers["X-Relay-Secret"]).toBe("rs");
    expect(JSON.parse(calls[0].init.body)).toEqual({ appid: "wx1", secret: "s1" });
  });

  it("passes a WeChat-side failure (e.g. 40164 IP not whitelisted) through verbatim", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ ok: false, errcode: 40164, errmsg: "invalid ip" }), { status: 200 }));
    const res = await onRequest(ctx({ appid: "wx1", secret: "s1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, errcode: 40164, errmsg: "invalid ip" });
  });

  it("400 when appid/secret missing", async () => {
    const res = await onRequest(ctx({ appid: "wx1" }));
    expect(res.status).toBe(400);
  });

  it("500 when the relay env vars are not configured", async () => {
    const res = await onRequest(ctx({ appid: "wx1", secret: "s1" }, { WECHAT_RELAY_URL: "", WECHAT_RELAY_SECRET: "" }));
    expect(res.status).toBe(500);
  });

  it("502 when the relay is unreachable", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("boom"); });
    const res = await onRequest(ctx({ appid: "wx1", secret: "s1" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("relay_unreachable");
  });

  it("401 without a valid token", async () => {
    const c = ctx({ appid: "wx1", secret: "s1" });
    c.request = new Request(c.request.url, { method: "POST", body: JSON.stringify({ appid: "wx1", secret: "s1" }) });
    const res = await onRequest(c);
    expect(res.status).toBe(401);
  });
});
