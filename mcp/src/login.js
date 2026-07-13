// 6+4 手机配对登录。
//
// 我们扮演协议里的「新设备」：生成一次性 X25519 密钥对，把公钥连同 6 位码发给
// 服务端；服务端随机生成 4 位码推到你手机上；你把手机上看到的 4 位码报回来，
// 手机就用我们的公钥把账号密钥封好送过来，我们用私钥解开。
//
// 为什么必须两次调用：4 位码是服务端在第一步**才生成**的，第一步之前它不存在。
// 而且它是安全性的关键——6 位码可能同时匹配多个账号（最多 10 个），服务端给每个
// 候选推**不同**的 4 位码。报对了，才同时证明「手机在你手上」和「你要哪个账号」。
//
// 无状态：私钥不存服务端，而是塞进返回给调用方的 pairing 句柄里，第二步再带回来。
// 反正下一步就要把账号密钥交出去了，私钥多走一趟不增加任何暴露。
//
// 加密契约必须和 iOS 的 DeviceLinkCrypto、agent worker、以及 skill 里的
// vd-login.mjs 完全一致，错一个字节就解不出来：
//   X25519 → HKDF-SHA256(salt="voicedrop-device-link/v1", info="anon-token", 32B)
//   → AES-256-GCM，blob.sealed = nonce(12) | ciphertext | tag(16)

import { AGENT_ORIGIN } from "./vd-client.js";

const SALT = new TextEncoder().encode("voicedrop-device-link/v1");
const INFO = new TextEncoder().encode("anon-token");
const LINK = `${AGENT_ORIGIN}/agent/link`;

// 手机没响应时别把用户吊死在这儿。
const PHONE_TIMEOUT_MS = 25_000;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) =>
  Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** 6 位十六进制 = 开始；4 位数字 = 完成。其余不认。 */
export function classifyCode(code) {
  const s = String(code ?? "").trim();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "prefix";
  if (/^[0-9]{4}$/.test(s)) return "verify";
  return null;
}

export function encodeHandle(h) {
  return b64url(new TextEncoder().encode(JSON.stringify(h)));
}

export function decodeHandle(s) {
  try {
    const h = JSON.parse(new TextDecoder().decode(unb64url(s)));
    return h && h.pairingId && h.priv && h.bearer ? h : null;
  } catch {
    return null;
  }
}

// start / verify 都要一个 bearer，但只用于限流——不是我们的最终身份，用完即弃。
const throwawayBearer = () =>
  "anon_" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 第一步：把 6 位码 + 我们的公钥交上去，手机随即弹出 4 位码。 */
export async function startPairing(sixHex, { fetch = globalThis.fetch } = {}) {
  const prefix = String(sixHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(prefix)) {
    throw new Error("6 位代码应该是十六进制——在手机的「设置 → 账户」里那串短 ID。");
  }

  const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pubkey = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = b64url(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const bearer = throwawayBearer();

  const res = await fetch(`${LINK}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, pubkey }),
  }).then((r) => r.json());

  if (res?.reason === "no_match") {
    throw new Error(
      "没找到这个账号。确认手机「设置 → 账户」里的 6 位码没抄错，并且手机在线、" +
        "App 在前台、已登录目标账号。",
    );
  }
  if (!res?.ok || !res.pairingId) throw new Error(`开始配对失败：${JSON.stringify(res)}`);

  return {
    pairing: encodeHandle({ pairingId: res.pairingId, priv, bearer }),
    matchCount: res.matchCount,
  };
}

/** 第二步：报上手机弹出的 4 位码，接回加密的账号密钥并解开。 */
export async function finishPairing(fourDigit, pairingHandle, { fetch = globalThis.fetch, connect } = {}) {
  const code = String(fourDigit ?? "").trim();
  if (!/^[0-9]{4}$/.test(code)) throw new Error("验证码应该是 4 位数字。");

  const st = decodeHandle(pairingHandle);
  if (!st) throw new Error("配对句柄无效或已丢失。请先用 6 位代码重新调一次 login 开始配对。");

  // 先连上 socket 再 verify——手机放行得很快，晚连会漏掉推送。
  const sock = await connect(`${LINK.replace(/^https/, "wss")}/socket?pairingId=${st.pairingId}`);

  try {
    const vr = await fetch(`${LINK}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${st.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pairingId: st.pairingId, code }),
    }).then((r) => r.json());

    if (!vr?.ok) {
      if (vr?.dead) throw new Error("验证码错太多次了，配对已作废。用 6 位代码重新开始。");
      if (vr?.expired) throw new Error("配对已过期（只给 2 分钟）。用 6 位代码重新开始。");
      throw new Error(`验证码不对，还能再试 ${vr?.remaining ?? "?"} 次。配对还活着，报个对的再调一次 login 就行。`);
    }

    const msg = await withTimeout(sock.next(), PHONE_TIMEOUT_MS);
    if (!msg) throw new Error("手机没有响应。确认手机在线、App 在前台、已登录该账号，然后重新开始。");
    if (msg.type === "link_cancelled") throw new Error("你在手机上点了「不是我」，配对已取消。");
    if (msg.type === "link_expired") throw new Error("配对已过期。用 6 位代码重新开始。");
    if (msg.type !== "link_ready" || !msg.blob) throw new Error(`手机返回了意料之外的消息：${msg.type}`);

    const token = await decryptBlob(msg.blob, st.priv);
    if (!token.startsWith("anon_")) throw new Error("解出来的不是有效凭证。");

    return { token, scope: `users/anon-${(await sha256hex(token)).slice(0, 32)}/` };
  } finally {
    sock.close();
  }
}

async function decryptBlob(blob, privB64) {
  const priv = await crypto.subtle.importKey("pkcs8", unb64url(privB64), { name: "X25519" }, false, ["deriveBits"]);
  const epk = await crypto.subtle.importKey("raw", unb64url(blob.epk), { name: "X25519" }, false, []);

  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: epk }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO }, hk, 256);
  const aes = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);

  // WebCrypto 的 AES-GCM 要 ciphertext 后面跟着 tag，正好是 sealed 去掉前 12 字节 nonce。
  const sealed = unb64url(blob.sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(0, 12) },
    aes,
    sealed.slice(12),
  );
  return new TextDecoder().decode(plain);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
}
