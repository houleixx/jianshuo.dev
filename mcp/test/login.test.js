import { describe, it, expect } from "vitest";
import { classifyCode, startPairing, finishPairing, encodeHandle, decodeHandle } from "../src/login.js";

// 加密契约必须和 iOS 的 DeviceLinkCrypto、Worker、以及 skill 里的 vd-login.mjs
// 一字不差，否则解不出来：X25519 → HKDF-SHA256(salt="voicedrop-device-link/v1",
// info="anon-token", 32B) → AES-256-GCM，blob = nonce(12) | ct | tag(16)。
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// 扮演「手机」：拿到我们的公钥，把 token 封成 blob。真加密，不是 mock。
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

// 假的 WS：测试自己决定手机「回」什么。
function fakeSocket(messages) {
  return () => ({
    async next() {
      return messages.shift();
    },
    close() {},
  });
}

describe("一个 login 工具，靠码的形状分辨阶段", () => {
  it("6 位十六进制 → 开始配对", () => {
    expect(classifyCode("a3f2b1")).toBe("prefix");
    expect(classifyCode("AE209A")).toBe("prefix"); // 大小写都认
  });

  it("4 位数字 → 完成配对", () => {
    expect(classifyCode("7391")).toBe("verify");
    expect(classifyCode("0042")).toBe("verify"); // 前导零不能丢
  });

  it("别的都不认", () => {
    for (const bad of ["", "12345", "abcdefg", "73911", "zzz", "a3f2b", null, undefined]) {
      expect(classifyCode(bad), `${bad} 不该被接受`).toBeNull();
    }
  });

  it("6 位十六进制里全是数字时，仍然是 6 位 → prefix（不能被 4 位规则抢走）", () => {
    expect(classifyCode("123456")).toBe("prefix");
  });
});

describe("配对句柄（无状态：服务端不存任何东西）", () => {
  it("编码再解码，原样还回来", () => {
    const h = { pairingId: "abc123", priv: "cHJpdg", bearer: "anon_x" };
    expect(decodeHandle(encodeHandle(h))).toEqual(h);
  });

  it("句柄是垃圾 → 返回 null，不抛异常", () => {
    expect(decodeHandle("这不是句柄")).toBeNull();
    expect(decodeHandle("")).toBeNull();
  });
});

describe("第一步：startPairing", () => {
  const okStart = async () =>
    new Response(JSON.stringify({ ok: true, pairingId: "p1", matchCount: 1 }), { status: 200 });

  it("把 6 位码和我们的公钥发给 /agent/link/start", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization };
      return okStart();
    };

    const out = await startPairing("A3F2B1", { fetch: fetchImpl });

    expect(seen.url).toContain("/agent/link/start");
    expect(seen.body.prefix).toBe("a3f2b1"); // 归一化成小写
    expect(seen.body.pubkey).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 字节 raw 公钥的 b64url
    expect(seen.auth).toMatch(/^Bearer anon_/); // 一次性身份，只为限流
    expect(out.matchCount).toBe(1);
  });

  it("句柄里带着私钥——因为服务端不存状态，下一步要靠它解密", async () => {
    const out = await startPairing("a3f2b1", { fetch: okStart });

    const h = decodeHandle(out.pairing);
    expect(h.pairingId).toBe("p1");
    expect(h.priv.length).toBeGreaterThan(20);
    expect(h.bearer).toMatch(/^anon_/);
  });

  it("6 位码不对 → 直接报错，不发请求", async () => {
    let called = false;
    await expect(
      startPairing("xyz", { fetch: async () => { called = true; return okStart(); } }),
    ).rejects.toThrow(/6 位/);
    expect(called).toBe(false);
  });

  it("no_match（手机离线/码错/旧版本）→ 说人话", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, reason: "no_match" }), { status: 200 });

    await expect(startPairing("a3f2b1", { fetch: fetchImpl })).rejects.toThrow(/没找到|手机/);
  });
});

describe("第二步：finishPairing —— 真解密", () => {
  const TOKEN = "anon_" + "ab".repeat(32);

  // 走完整的一步：真的 start 拿到句柄，再让「手机」用它的公钥封 token。
  async function realHandshake() {
    const started = await startPairing("a3f2b1", {
      fetch: async () => new Response(JSON.stringify({ ok: true, pairingId: "p1", matchCount: 1 }), { status: 200 }),
    });
    let pubkey;
    // 从 start 的请求里把我们的公钥抠出来（上面那次没记，重来一次并记住）
    await startPairing("a3f2b1", {
      fetch: async (_u, init) => {
        pubkey = JSON.parse(init.body).pubkey;
        return new Response(JSON.stringify({ ok: true, pairingId: "p1", matchCount: 1 }), { status: 200 });
      },
    });
    return { started, pubkey };
  }

  it("4 位码对了 + 手机放行 → 解出真 token", async () => {
    // 用同一个 start 调用的公钥，才能解得开——所以这里自己造一对完整的。
    let ourPub;
    const started = await startPairing("a3f2b1", {
      fetch: async (_u, init) => {
        ourPub = JSON.parse(init.body).pubkey;
        return new Response(JSON.stringify({ ok: true, pairingId: "p1", matchCount: 1 }), { status: 200 });
      },
    });
    const blob = await sealAsPhone(TOKEN, ourPub);

    const out = await finishPairing("7391", started.pairing, {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      connect: fakeSocket([{ type: "link_ready", blob }]),
    });

    expect(out.token).toBe(TOKEN);
    // scope 是从 token 算出来的，和服务端的推导一致
    expect(out.scope).toMatch(/^users\/anon-[0-9a-f]{32}\/$/);
  });

  it("4 位码错 → 说还能试几次（配对还活着，别让用户重头来）", async () => {
    const started = await startPairing("a3f2b1", {
      fetch: async () => new Response(JSON.stringify({ ok: true, pairingId: "p1" }), { status: 200 }),
    });

    await expect(
      finishPairing("0000", started.pairing, {
        fetch: async () => new Response(JSON.stringify({ ok: false, remaining: 3 }), { status: 200 }),
        connect: fakeSocket([]),
      }),
    ).rejects.toThrow(/还.*3.*次|不对/);
  });

  it("手机上点了「不是我」→ cancelled", async () => {
    const started = await startPairing("a3f2b1", {
      fetch: async () => new Response(JSON.stringify({ ok: true, pairingId: "p1" }), { status: 200 }),
    });

    await expect(
      finishPairing("7391", started.pairing, {
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        connect: fakeSocket([{ type: "link_cancelled" }]),
      }),
    ).rejects.toThrow(/不是我|取消/);
  });

  it("配对过期 → 让用户重来", async () => {
    const started = await startPairing("a3f2b1", {
      fetch: async () => new Response(JSON.stringify({ ok: true, pairingId: "p1" }), { status: 200 }),
    });

    await expect(
      finishPairing("7391", started.pairing, {
        fetch: async () => new Response(JSON.stringify({ ok: false, expired: true }), { status: 200 }),
        connect: fakeSocket([]),
      }),
    ).rejects.toThrow(/过期|重/);
  });

  it("试太多次 → dead", async () => {
    const started = await startPairing("a3f2b1", {
      fetch: async () => new Response(JSON.stringify({ ok: true, pairingId: "p1" }), { status: 200 }),
    });

    await expect(
      finishPairing("7391", started.pairing, {
        fetch: async () => new Response(JSON.stringify({ ok: false, dead: true }), { status: 200 }),
        connect: fakeSocket([]),
      }),
    ).rejects.toThrow(/次数|重/);
  });

  it("句柄丢了/是垃圾 → 提示先做第一步", async () => {
    await expect(
      finishPairing("7391", "垃圾句柄", { fetch: async () => new Response("{}"), connect: fakeSocket([]) }),
    ).rejects.toThrow(/先|6 位/);
  });

  it("解出来的不是 anon_ 开头 → 拒绝，别把垃圾当凭证交出去", async () => {
    let ourPub;
    const started = await startPairing("a3f2b1", {
      fetch: async (_u, init) => {
        ourPub = JSON.parse(init.body).pubkey;
        return new Response(JSON.stringify({ ok: true, pairingId: "p1" }), { status: 200 });
      },
    });
    const blob = await sealAsPhone("这不是token", ourPub);

    await expect(
      finishPairing("7391", started.pairing, {
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        connect: fakeSocket([{ type: "link_ready", blob }]),
      }),
    ).rejects.toThrow(/凭证|无效/);
  });
});
