import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
import { b64url, b64urlToString, hmacSign } from "../../functions/lib/auth.js";

function ctx(method, path, { seed = {}, body } = {}) {
  const env = {
    ...fakeEnv(seed),
    FILES_TOKEN: "admin",
    SESSION_SECRET: "test-session",
    WECHAT_RELAY_URL: "https://relay.example/publish",
    WECHAT_RELAY_SECRET: "relay-secret",
  };
  const request = new Request("https://voicedrop.cn/files/api/" + path, {
    method,
    headers: { Authorization: "Bearer admin", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: path.split("/") } };
}

async function userCtx(method, path, seed) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ scope: "users/u/", exp: Math.floor(Date.now() / 1000) + 3600 }));
  const token = `${header}.${payload}.${await hmacSign(`${header}.${payload}`, "test-session")}`;
  const c = ctx(method, path, { seed });
  c.request = new Request(`https://voicedrop.cn/files/api/${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return c;
}

async function signedWechatState(scope, expiresAt = Date.now() + 60_000) {
  const payload = b64url(JSON.stringify({ s: scope, e: expiresAt }));
  return `${payload}.${await hmacSign(`wechat-auth-state:${payload}`, "test-session")}`;
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("微信公众号第三方授权状态", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("验证第三方平台回调并持久化推送的 verify ticket", async () => {
    const timestamp = "1710000000";
    const nonce = "nonce";
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(["callback-token", timestamp, nonce].sort().join("")));
    const signature = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
    const c = ctx("GET", "wechat/component-callback");
    c.env.WECHAT_COMPONENT_CALLBACK_TOKEN = "callback-token";
    c.request = new Request(`https://voicedrop.cn/files/api/wechat/component-callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}&echostr=challenge`);
    c.params = { path: ["wechat", "component-callback"] };
    expect(await (await onRequest(c)).text()).toBe("challenge");

    c.request = new Request(`https://voicedrop.cn/files/api/wechat/component-callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`, {
      method: "POST", body: "<xml><InfoType>component_verify_ticket</InfoType><ComponentVerifyTicket>new-ticket</ComponentVerifyTicket></xml>",
    });
    expect((await onRequest(c)).status).toBe(200);
    expect(JSON.parse(await (await c.env.FILES.get("config/wechat-component.json")).text())).toMatchObject({ component_verify_ticket: "new-ticket" });
  });

  it("可以解密微信安全模式下使用 32 字节 PKCS#7 填充的 ticket 推送", async () => {
    const callbackToken = "callback-token";
    const componentAppId = "component-appid";
    const timestamp = "1710000000";
    const nonce = "nonce";
    const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const encodingAesKey = base64(keyBytes).replace(/=+$/, "");
    let innerXml = "<xml><InfoType>component_verify_ticket</InfoType><ComponentVerifyTicket>encrypted-ticket</ComponentVerifyTicket></xml>";
    const encoder = new TextEncoder();
    while (true) {
      const unpaddedSize = 20 + encoder.encode(innerXml).length + encoder.encode(componentAppId).length;
      const padding = 32 - (unpaddedSize % 32);
      if (padding === 20) break;
      innerXml += " ";
    }
    const xmlBytes = encoder.encode(innerXml);
    const appIdBytes = encoder.encode(componentAppId);
    const unpadded = new Uint8Array(20 + xmlBytes.length + appIdBytes.length);
    unpadded.set(Uint8Array.from({ length: 16 }, (_, index) => index), 0);
    new DataView(unpadded.buffer).setUint32(16, xmlBytes.length);
    unpadded.set(xmlBytes, 20);
    unpadded.set(appIdBytes, 20 + xmlBytes.length);
    const padding = 32 - (unpadded.length % 32);
    const padded = new Uint8Array(unpadded.length + padding);
    padded.set(unpadded);
    padded.fill(padding, unpadded.length);
    const aes = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
    // Web Crypto adds its own 16-byte padding block. Drop that final block to
    // obtain the wire format produced by WeChat's 32-byte PKCS#7 implementation.
    const withWebPadding = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: keyBytes.slice(0, 16) }, aes, padded));
    const encrypted = base64(withWebPadding.slice(0, -16));
    const digest = await crypto.subtle.digest("SHA-1", encoder.encode([callbackToken, timestamp, nonce, encrypted].sort().join("")));
    const signature = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
    const c = ctx("POST", "wechat/component-callback");
    Object.assign(c.env, {
      WECHAT_COMPONENT_CALLBACK_TOKEN: callbackToken,
      WECHAT_COMPONENT_AES_KEY: encodingAesKey,
      WECHAT_COMPONENT_APP_ID: componentAppId,
    });
    c.request = new Request(`https://voicedrop.cn/files/api/wechat/component-callback?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${signature}`, {
      method: "POST",
      body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    });
    c.params = { path: ["wechat", "component-callback"] };

    expect((await onRequest(c)).status).toBe(200);
    expect(JSON.parse(await (await c.env.FILES.get("config/wechat-component.json")).text())).toMatchObject({
      component_verify_ticket: "encrypted-ticket",
    });
  });

  it("认证用户可读取当前 WECHAT.json 中的第三方授权状态", async () => {
    const c = ctx("GET", "wechat/bind-status", {
      seed: {
        "WECHAT.json": JSON.stringify({
          provider: "wechat_third_party",
          authorizer_appid: "wx-authorizer",
          account_name: "测试公众号",
          enabled: true,
          access_token: "access-token",
          refresh_token: "refresh-token",
          access_token_expires_at: 1780000000000,
        }),
      },
    });

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: true,
      authorizer_appid: "wx-authorizer",
      account_name: "测试公众号",
      enabled: true,
    });
  });

  it("查询连接状态只读取授权记录，不刷新已过期的 authorizer token", async () => {
    const c = await userCtx("GET", "wechat/bind-status", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token",
        component_access_token_expires_at: Date.now() + 3_600_000,
      }),
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party",
        authorizer_appid: "wx-authorizer",
        account_name: "测试公众号",
        access_token: "expired",
        refresh_token: "refresh-token",
        access_token_expires_at: 1,
      }),
    });
    const fetchWechat = vi.fn(async () => {
      throw new Error("bind-status must not call WeChat");
    });
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    vi.stubGlobal("fetch", fetchWechat);

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true });
    expect(fetchWechat).not.toHaveBeenCalled();
    expect(JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text())).toMatchObject({
      access_token: "expired",
      refresh_token: "refresh-token",
      access_token_expires_at: 1,
    });
  });

  it("缺少 refresh token 的残缺授权不会显示为已连接", async () => {
    const c = await userCtx("GET", "wechat/bind-status", {
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party",
        authorizer_appid: "wx-authorizer",
        account_name: "测试公众号",
        access_token: "expired",
        access_token_expires_at: 1,
      }),
    });

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
  });

  it("取消连接只移除第三方授权字段，保留旧配置和封面缓存", async () => {
    const c = ctx("POST", "wechat/unbind", {
      seed: {
        "WECHAT.json": JSON.stringify({
          provider: "wechat_third_party",
          authorizer_appid: "wx-authorizer",
          account_name: "测试公众号",
          access_token: "access-token",
          refresh_token: "refresh-token",
          access_token_expires_at: 1780000000000,
          appid: "legacy-appid",
          secret: "legacy-secret",
          enabled: false,
          coverMediaIds: { default: "media-cover" },
        }),
      },
    });

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
    expect(JSON.parse(await (await c.env.FILES.get("WECHAT.json")).text())).toEqual({
      appid: "legacy-appid",
      secret: "legacy-secret",
      enabled: false,
      coverMediaIds: { default: "media-cover" },
    });
  });

  it("发布草稿时将第三方 access_token 交给 relay", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party", authorizer_appid: "wx-authorizer", access_token: "authorizer-token",
        refresh_token: "refresh-token", access_token_expires_at: Date.now() + 3_600_000,
      }),
      "users/u/articles/s1.json": JSON.stringify({
        schema: 3, createdAt: 1, transcript: "t", head: 1,
        versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "标题", body: "正文" }] }],
      }),
    });
    c.env.WECHAT_RELAY_URL = "https://relay.example/publish";
    c.env.WECHAT_RELAY_SECRET = "relay-secret";
    const relay = vi.fn(async () => new Response(JSON.stringify({ ok: true, article: { articles: [{ title: "标题", body: "正文" }] } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", relay);

    expect((await onRequest(c)).status).toBe(200);
    expect(JSON.parse(relay.mock.calls[0][1].body)).toMatchObject({ access_token: "authorizer-token", authorizer_appid: "wx-authorizer" });
  });

  it("access_token 和旧 appid/secret 同时存在时优先把 access_token 交给 relay", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "users/u/WECHAT.json": JSON.stringify({
        authorizer_appid: "wx-authorizer",
        access_token: "authorizer-token",
        refresh_token: "refresh-token",
        access_token_expires_at: Date.now() + 3_600_000,
        appid: "legacy-appid",
        secret: "legacy-secret",
      }),
      "users/u/articles/s1.json": JSON.stringify({
        schema: 3, createdAt: 1, transcript: "t", head: 1,
        versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "标题", body: "正文" }] }],
      }),
    });
    Object.assign(c.env, {
      WECHAT_RELAY_URL: "https://relay.example/publish",
      WECHAT_RELAY_SECRET: "relay-secret",
    });
    let sent;
    const relay = vi.fn(async (_input, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ok: true,
        article: { articles: [{ title: "标题", body: "正文" }] },
      }));
    });
    vi.stubGlobal("fetch", relay);

    expect((await onRequest(c)).status).toBe(200);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({
      access_token: "authorizer-token",
      authorizer_appid: "wx-authorizer",
    });
    expect(sent).not.toHaveProperty("appid");
    expect(sent).not.toHaveProperty("secret");
  });

  it("混合配置中的 access_token 过期时先刷新，再使用新 token 调 relay", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token",
        component_access_token_expires_at: Date.now() + 3_600_000,
      }),
      "users/u/WECHAT.json": JSON.stringify({
        authorizer_appid: "wx-authorizer",
        access_token: "expired-token",
        refresh_token: "old-refresh",
        access_token_expires_at: 1,
        appid: "legacy-appid",
        secret: "legacy-secret",
      }),
      "users/u/articles/s1.json": JSON.stringify({
        schema: 3, createdAt: 1, transcript: "t", head: 1,
        versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "标题", body: "正文" }] }],
      }),
    });
    Object.assign(c.env, {
      WECHAT_RELAY_URL: "https://relay.example/publish",
      WECHAT_RELAY_SECRET: "relay-secret",
      WECHAT_COMPONENT_APP_ID: "component-appid",
    });
    const calls = [];
    let sent;
    vi.stubGlobal("fetch", async (input, init = {}) => {
      calls.push(String(input));
      if (String(input).endsWith("/authorizer-token")) {
        expect(JSON.parse(init.body)).toEqual({
          component_access_token: "component-token",
          component_appid: "component-appid",
          authorizer_appid: "wx-authorizer",
          authorizer_refresh_token: "old-refresh",
        });
        return new Response(JSON.stringify({
          authorizer_access_token: "fresh-token",
          authorizer_refresh_token: "fresh-refresh",
          expires_in: 7200,
        }));
      }
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ok: true,
        article: { articles: [{ title: "标题", body: "正文" }] },
      }));
    });

    expect((await onRequest(c)).status).toBe(200);
    expect(calls.filter((url) => url.endsWith("/authorizer-token"))).toHaveLength(1);
    expect(sent).toMatchObject({
      access_token: "fresh-token",
      authorizer_appid: "wx-authorizer",
    });
    expect(sent).not.toHaveProperty("appid");
    expect(sent).not.toHaveProperty("secret");
    expect(JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text())).toMatchObject({
      access_token: "fresh-token",
      refresh_token: "fresh-refresh",
    });
  });

  it("发布前会用 component token 刷新已过期的 authorizer token", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "config/wechat-component.json": JSON.stringify({ component_verify_ticket: "ticket" }),
      "users/u/WECHAT.json": JSON.stringify({ provider: "wechat_third_party", authorizer_appid: "wx-authorizer", access_token: "expired", refresh_token: "refresh-token", access_token_expires_at: 1 }),
      "users/u/articles/s1.json": JSON.stringify({ schema: 3, createdAt: 1, transcript: "t", head: 0, versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "标题", body: "正文" }] }] }),
    });
    Object.assign(c.env, { WECHAT_RELAY_URL: "https://relay.example/publish", WECHAT_RELAY_SECRET: "relay-secret", WECHAT_COMPONENT_APP_ID: "component-appid", WECHAT_COMPONENT_APP_SECRET: "component-secret" });
    const calls = [];
    vi.stubGlobal("fetch", async (input, init = {}) => {
      calls.push([String(input), init]);
      if (String(input).endsWith("/component-token")) {
        expect(JSON.parse(init.body)).toEqual({
          component_appid: "component-appid",
          component_appsecret: "component-secret",
          component_verify_ticket: "ticket",
        });
        return new Response(JSON.stringify({ component_access_token: "component-token", expires_in: 7200 }));
      }
      if (String(input).endsWith("/authorizer-token")) {
        expect(JSON.parse(init.body)).toEqual({
          component_access_token: "component-token",
          component_appid: "component-appid",
          authorizer_appid: "wx-authorizer",
          authorizer_refresh_token: "refresh-token",
        });
        return new Response(JSON.stringify({ authorizer_access_token: "fresh-token", authorizer_refresh_token: "fresh-refresh", expires_in: 7200 }));
      }
      return new Response(JSON.stringify({ ok: true, article: { articles: [{ title: "标题", body: "正文" }] } }));
    });

    expect((await onRequest(c)).status).toBe(200);
    expect(JSON.parse(calls.at(-1)[1].body)).toMatchObject({ access_token: "fresh-token", authorizer_appid: "wx-authorizer" });
    expect(JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text())).toMatchObject({ access_token: "fresh-token", refresh_token: "fresh-refresh" });
  });

  it("authorizer token 刷新成功后即使 relay 失败也会立即落盘", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token",
        component_access_token_expires_at: Date.now() + 3_600_000,
      }),
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party",
        authorizer_appid: "wx-authorizer",
        access_token: "expired",
        refresh_token: "old-refresh",
        access_token_expires_at: 1,
      }),
      "users/u/articles/s1.json": JSON.stringify({
        schema: 3, createdAt: 1, transcript: "t", head: 0,
        versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "标题", body: "正文" }] }],
      }),
    });
    Object.assign(c.env, {
      WECHAT_RELAY_URL: "https://relay.example/publish",
      WECHAT_RELAY_SECRET: "relay-secret",
      WECHAT_COMPONENT_APP_ID: "component-appid",
    });
    vi.stubGlobal("fetch", async (input) => {
      if (String(input).endsWith("/authorizer-token")) {
        return new Response(JSON.stringify({
          authorizer_access_token: "fresh-token",
          authorizer_refresh_token: "fresh-refresh",
          expires_in: 7200,
        }));
      }
      return new Response(JSON.stringify({ error: "relay down" }), { status: 502 });
    });

    expect((await onRequest(c)).status).toBe(502);
    expect(JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text())).toMatchObject({
      access_token: "fresh-token",
      refresh_token: "fresh-refresh",
    });
  });

  it("换绑后发布不会把旧公众号 wechatMediaId 交给 relay，并为新 id 标记所属账号", async () => {
    const c = await userCtx("POST", "wechat/articles/s1.json", {
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party",
        authorizer_appid: "wx-new",
        media_authorizer_appid: "wx-old",
        access_token: "new-access",
        refresh_token: "new-refresh",
        access_token_expires_at: Date.now() + 3_600_000,
      }),
      "users/u/articles/s1.json": JSON.stringify({
        schema: 3, createdAt: 1, transcript: "t", head: 1,
        versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{
          title: "标题", body: "正文", wechatMediaId: "old-media-id",
        }] }],
      }),
    });
    Object.assign(c.env, {
      WECHAT_RELAY_URL: "https://relay.example/publish",
      WECHAT_RELAY_SECRET: "relay-secret",
    });
    let sent;
    vi.stubGlobal("fetch", async (_input, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ok: true,
        article: { articles: [{ title: "标题", body: "正文", wechatMediaId: "new-media-id" }] },
        created: 1,
      }));
    });

    expect((await onRequest(c)).status).toBe(200);
    expect(sent.article.articles[0].wechatMediaId).toBeUndefined();
    const stored = JSON.parse(await (await c.env.FILES.get("users/u/articles/s1.json")).text());
    const latest = stored.versions.find((version) => version.v === stored.head).articles[0];
    expect(latest).toMatchObject({
      wechatMediaId: "new-media-id",
      wechatAuthorizerAppid: "wx-new",
    });
  });

  it("旧 App 覆盖上传 WECHAT.json 时保留第三方授权字段", async () => {
    const c = ctx("PUT", "upload/WECHAT.json", {
      seed: {
        "WECHAT.json": JSON.stringify({
          provider: "wechat_third_party",
          authorizer_appid: "wx-authorizer",
          account_name: "测试公众号",
          access_token: "access-token",
          refresh_token: "refresh-token",
          access_token_expires_at: 1780000000000,
          enabled: true,
          coverMediaIds: { old: "media-old" },
        }),
      },
      body: {
        appid: "legacy-appid",
        secret: "legacy-secret",
        enabled: false,
        coverMediaIds: { next: "media-next" },
      },
    });

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(JSON.parse(await (await c.env.FILES.get("WECHAT.json")).text())).toEqual({
      provider: "wechat_third_party",
      authorizer_appid: "wx-authorizer",
      account_name: "测试公众号",
      access_token: "access-token",
      refresh_token: "refresh-token",
      access_token_expires_at: 1780000000000,
      appid: "legacy-appid",
      secret: "legacy-secret",
      enabled: false,
      coverMediaIds: { next: "media-next" },
    });
  });

  it("创建授权只返回包含用户和有效期的签名 state，不写 R2 临时会话", async () => {
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await userCtx("POST", "wechat/authorization");
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    c.env.WECHAT_AUTH_BASE_URL = "https://voicedrop.cn/files/api";

    const response = await onRequest(c);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scan_url).toMatch(/^https:\/\/voicedrop\.cn\/files\/api\/wechat\/scan\?state=/);
    const state = new URL(body.scan_url).searchParams.get("state");
    expect(state).toBeTruthy();
    const [encoded, signature, extra] = state.split(".");
    expect(extra).toBeUndefined();
    expect(signature).toBeTruthy();
    expect(JSON.parse(b64urlToString(encoded))).toEqual({
      s: "users/u/",
      e: expect.any(Number),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await c.env.FILES.list({ prefix: "config/wechat-bind-sessions/" })).objects).toHaveLength(0);
  });

  it("扫码入口校验签名后申请 pre_auth_code，并用前端 JS 打开微信授权页", async () => {
    const c = await userCtx("POST", "wechat/authorization", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token",
        component_access_token_expires_at: Date.now() + 120_000,
      }),
    });
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    c.env.WECHAT_AUTH_BASE_URL = "https://voicedrop.cn/files/api";
    const state = new URL((await (await onRequest(c)).json()).scan_url).searchParams.get("state");
    vi.stubGlobal("fetch", async (url, init) => {
      expect(String(url)).toBe("https://relay.example/pre-auth-code");
      expect(init.headers["X-Relay-Secret"]).toBe("relay-secret");
      expect(JSON.parse(init.body)).toEqual({
        component_access_token: "component-token",
        component_appid: "component-appid",
      });
      return new Response(JSON.stringify({ pre_auth_code: "pre-auth-code" }));
    });
    c.request = new Request("https://voicedrop.cn/files/api/wechat/scan?state=" + state);
    c.params = { path: ["wechat", "scan"] };

    const response = await onRequest(c);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("window.location.replace");
    expect(html).toContain("componentloginpage");
    expect(html).toContain("pre-auth-code");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("origin");
  });

  it("旧 R2 会话和被篡改的 state 都不能打开授权页", async () => {
    const oldState = "old-r2-state";
    const c = ctx("GET", "wechat/scan", {
      seed: {
        ["config/wechat-bind-sessions/" + oldState + ".json"]: JSON.stringify({
          scope: "users/u/", expires_at: Date.now() + 60_000,
          auth_url: "https://mp.weixin.qq.com/",
        }),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    c.request = new Request("https://voicedrop.cn/files/api/wechat/scan?state=" + oldState);
    c.params = { path: ["wechat", "scan"] };
    expect((await onRequest(c)).status).toBe(410);

    const valid = await signedWechatState("users/u/");
    const tampered = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    c.request = new Request("https://voicedrop.cn/files/api/wechat/scan?state=" + tampered);
    expect((await onRequest(c)).status).toBe(410);
    expect(fetchMock.mock.calls.some(([requestUrl]) => String(requestUrl).includes("api.weixin.qq.com"))).toBe(false);
  });

  it("过期的签名 state 不能打开授权页", async () => {
    const state = await signedWechatState("users/u/", Date.now() - 1);
    const c = ctx("GET", "wechat/scan");
    c.request = new Request("https://voicedrop.cn/files/api/wechat/scan?state=" + state);
    c.params = { path: ["wechat", "scan"] };
    expect((await onRequest(c)).status).toBe(410);
  });

  it("扫码时组件 access token 过期，会先刷新组件状态再申请 pre_auth_code", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/component-token")) {
        expect(JSON.parse(init.body)).toEqual({
          component_appid: "component-appid",
          component_appsecret: "component-secret",
          component_verify_ticket: "ticket",
        });
        return new Response(JSON.stringify({ component_access_token: "fresh-component-token", expires_in: 7200 }));
      }
      if (String(url).endsWith("/pre-auth-code")) {
        expect(JSON.parse(init.body)).toEqual({
          component_access_token: "fresh-component-token",
          component_appid: "component-appid",
        });
        return new Response(JSON.stringify({ pre_auth_code: "pre-auth-code" }));
      }
      return new Response("not found", { status: 404 });
    });
    const c = await userCtx("POST", "wechat/authorization", {
      "config/wechat-component.json": JSON.stringify({
        component_verify_ticket: "ticket",
        component_access_token: "expired-token",
        component_access_token_expires_at: Date.now() - 1,
      }),
    });
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    c.env.WECHAT_COMPONENT_APP_SECRET = "component-secret";
    const state = new URL((await (await onRequest(c)).json()).scan_url).searchParams.get("state");
    c.request = new Request("https://voicedrop.cn/files/api/wechat/scan?state=" + state);
    c.params = { path: ["wechat", "scan"] };

    const response = await onRequest(c);

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "https://relay.example/component-token",
      "https://relay.example/pre-auth-code",
    ]);
    expect(JSON.parse(await (await c.env.FILES.get("config/wechat-component.json")).text())).toMatchObject({
      component_verify_ticket: "ticket",
      component_access_token: "fresh-component-token",
    });
  });

  it("授权回调拒绝过期的签名 state，不请求微信也不写用户授权", async () => {
    const state = await signedWechatState("users/u/", Date.now() - 1);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const c = ctx("GET", "wechat/auth-callback");
    c.request = new Request("https://voicedrop.cn/files/api/wechat/auth-callback?state=" + state + "&auth_code=code");
    c.params = { path: ["wechat", "auth-callback"] };

    expect((await onRequest(c)).status).toBe(410);
    expect(await c.env.FILES.get("users/u/WECHAT.json")).toBeNull();
    expect(fetchMock.mock.calls.some(([requestUrl]) => String(requestUrl).includes("api.weixin.qq.com"))).toBe(false);
  });

  it("授权回调合并更新用户 WECHAT.json 并跳转成功页", async () => {
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).endsWith("/query-auth")) {
        expect(JSON.parse(init.body)).toEqual({
          component_access_token: "component-token",
          component_appid: "component-appid",
          authorization_code: "code",
        });
        return new Response(JSON.stringify({ authorization_info: {
          authorizer_appid: "wx-authorizer", authorizer_access_token: "new-access",
          authorizer_refresh_token: "new-refresh", expires_in: 7200,
        } }));
      }
      if (String(url).endsWith("/authorizer-info")) {
        expect(JSON.parse(init.body)).toEqual({
          component_access_token: "component-token",
          component_appid: "component-appid",
          authorizer_appid: "wx-authorizer",
        });
        return new Response(JSON.stringify({ authorizer_info: { nick_name: "新公众号" } }));
      }
      return new Response("not found", { status: 404 });
    });
    const c = await userCtx("POST", "wechat/authorization", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token", component_access_token_expires_at: Date.now() + 120_000,
      }),
      "users/u/WECHAT.json": JSON.stringify({ enabled: false, coverMediaIds: { default: "cover-id" } }),
    });
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    const state = new URL((await (await onRequest(c)).json()).scan_url).searchParams.get("state");
    c.request = new Request("https://voicedrop.cn/files/api/wechat/auth-callback?state=" + state + "&auth_code=code");
    c.params = { path: ["wechat", "auth-callback"] };

    const response = await onRequest(c);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/files/api/wechat/auth-success");
    expect(JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text())).toMatchObject({
      provider: "wechat_third_party",
      authorizer_appid: "wx-authorizer",
      account_name: "新公众号",
      access_token: "new-access",
      refresh_token: "new-refresh",
      enabled: false,
      coverMediaIds: { default: "cover-id" },
    });
    expect((await c.env.FILES.list({ prefix: "config/wechat-bind-sessions/" })).objects).toHaveLength(0);
  });

  it("换绑另一个公众号时清除旧封面缓存并记录旧 media_id 的所属账号", async () => {
    vi.stubGlobal("fetch", async (url) => {
      if (String(url).endsWith("/query-auth")) {
        return new Response(JSON.stringify({ authorization_info: {
          authorizer_appid: "wx-new", authorizer_access_token: "new-access",
          authorizer_refresh_token: "new-refresh", expires_in: 7200,
        } }));
      }
      return new Response(JSON.stringify({ authorizer_info: { nick_name: "新公众号" } }));
    });
    const c = await userCtx("POST", "wechat/authorization", {
      "config/wechat-component.json": JSON.stringify({
        component_access_token: "component-token",
        component_access_token_expires_at: Date.now() + 120_000,
      }),
      "users/u/WECHAT.json": JSON.stringify({
        provider: "wechat_third_party",
        authorizer_appid: "wx-old",
        access_token: "old-access",
        refresh_token: "old-refresh",
        coverMediaIds: { default: "old-cover" },
      }),
    });
    c.env.WECHAT_COMPONENT_APP_ID = "component-appid";
    const state = new URL((await (await onRequest(c)).json()).scan_url).searchParams.get("state");
    c.request = new Request(`https://voicedrop.cn/files/api/wechat/auth-callback?state=${state}&auth_code=code`);
    c.params = { path: ["wechat", "auth-callback"] };

    expect((await onRequest(c)).status).toBe(302);
    const stored = JSON.parse(await (await c.env.FILES.get("users/u/WECHAT.json")).text());
    expect(stored).toMatchObject({
      authorizer_appid: "wx-new",
      media_authorizer_appid: "wx-old",
    });
    expect(stored.coverMediaIds).toBeUndefined();
  });
});
