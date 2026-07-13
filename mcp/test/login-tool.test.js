import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";
import { handleRequest } from "../src/http.js";

const login = TOOLS.find((t) => t.name === "login");

const jsonResp = (body) => new Response(JSON.stringify(body), { status: 200 });
const fakeSocket = (messages) => async () => ({
  async next() { return messages.shift(); },
  close() {},
});

describe("工具表里只有一个 login", () => {
  it("存在，且只有一个（不是 login_start / login_finish 两个）", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("login");
    expect(names).not.toContain("login_start");
    expect(names).not.toContain("login_finish");
  });

  it("只有 code 是必填 —— pairing 是第二次调用才带的", () => {
    expect(login.inputSchema.required).toEqual(["code"]);
    expect(login.inputSchema.properties.pairing).toBeDefined();
  });

  it("描述里讲清楚了要调两次，否则模型只会调一次然后卡住", () => {
    expect(login.description).toMatch(/两次|再调|4 位/);
  });
});

describe("同一个工具，靠码的形状分辨阶段", () => {
  it("给 6 位码 → 开始配对，回句柄并叫用户去看手机", async () => {
    const out = await login.handler(
      { code: "a3f2b1" },
      { fetch: async () => jsonResp({ ok: true, pairingId: "p1", matchCount: 1 }), connect: fakeSocket([]) },
    );

    expect(out.pairing).toBeTruthy();
    expect(out.next).toMatch(/手机|4 位/);
    expect(out.token).toBeUndefined(); // 这一步还没有 token
  });

  it("给 4 位码 + 句柄 → 完成配对，把 token 交出来并告诉你怎么配", async () => {
    // 先真开一次，拿到能解密的句柄
    let ourPub;
    const started = await login.handler(
      { code: "a3f2b1" },
      {
        fetch: async (_u, init) => {
          ourPub = JSON.parse(init.body).pubkey;
          return jsonResp({ ok: true, pairingId: "p1", matchCount: 1 });
        },
        connect: fakeSocket([]),
      },
    );

    const TOKEN = "anon_" + "cd".repeat(32);
    const blob = await sealAsPhone(TOKEN, ourPub);

    const out = await login.handler(
      { code: "7391", pairing: started.pairing },
      { fetch: async () => jsonResp({ ok: true }), connect: fakeSocket([{ type: "link_ready", blob }]) },
    );

    expect(out.token).toBe(TOKEN);
    expect(out.scope).toMatch(/^users\/anon-/);
    expect(out.next).toMatch(/Authorization|配置|claude mcp/); // 得告诉用户下一步怎么办
  });

  it("给 4 位码却没带句柄 → 提示先用 6 位码开始", async () => {
    await expect(
      login.handler({ code: "7391" }, { fetch: async () => jsonResp({}), connect: fakeSocket([]) }),
    ).rejects.toThrow(/先|6 位/);
  });

  it("码的形状不对 → 说清楚要 6 位十六进制或 4 位数字", async () => {
    await expect(
      login.handler({ code: "12345" }, { fetch: async () => jsonResp({}), connect: fakeSocket([]) }),
    ).rejects.toThrow(/6 位|4 位/);
  });
});

describe("login 必须免 token —— 不然就是死锁：要登录才能拿 token，要 token 才能登录", () => {
  it("没有 Authorization 头也能调 login", async () => {
    const res = await handleRequest(
      new Request("https://voicedrop.cn/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "login", arguments: { code: "a3f2b1" } },
        }),
      }),
      {
        fetch: async () => jsonResp({ ok: true, pairingId: "p1", matchCount: 1 }),
        connect: fakeSocket([]),
      },
    );

    expect(res.status).toBe(200); // 不是 401
    const body = await res.json();
    expect(body.result.isError).toBe(false);
  });

  it("别的工具没 token 照样 401（login 是唯一的例外）", async () => {
    const res = await handleRequest(
      new Request("https://voicedrop.cn/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "list_articles", arguments: {} },
        }),
      }),
      { fetch: async () => jsonResp({}) },
    );

    expect(res.status).toBe(401);
  });
});

// ── 扮演手机：真加密，不是 mock ──
const b64url = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sealAsPhone(token, ourRawPub) {
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ourPub = await crypto.subtle.importKey("raw", unb64url(ourRawPub), { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ourPub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF", hash: "SHA-256",
      salt: new TextEncoder().encode("voicedrop-device-link/v1"),
      info: new TextEncoder().encode("anon-token"),
    }, hk, 256);
  const aes = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, new TextEncoder().encode(token));
  const sealed = new Uint8Array(12 + ct.byteLength);
  sealed.set(nonce, 0);
  sealed.set(new Uint8Array(ct), 12);
  return { epk: b64url(await crypto.subtle.exportKey("raw", eph.publicKey)), sealed: b64url(sealed) };
}
