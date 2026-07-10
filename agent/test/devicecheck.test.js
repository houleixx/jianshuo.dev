// test/devicecheck.test.js — DeviceCheck 两 bit 防重装（fetch 注入，不打真 Apple）
import { describe, it, expect } from "vitest";
import { deviceCheckGate, deviceCheckMark } from "../src/devicecheck.js";

// 合法 P-256 pkcs8 测试私钥（仅本地签 JWT 用，不打真 Apple）
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const envOk = { APNS_KEY_P8: TEST_P8, APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "97XBW2A43H" };

describe("deviceCheckGate", () => {
  it("unavailable when secrets missing", async () => {
    expect(await deviceCheckGate({}, "tok")).toBe("unavailable");
  });
  it("unavailable when no device token", async () => {
    expect(await deviceCheckGate(envOk, "")).toBe("unavailable");
  });
  it("fresh when bits never set", async () => {
    const fetcher = async () => new Response("Failed to find bit state", { status: 200 });
    expect(await deviceCheckGate(envOk, "tok", fetcher)).toBe("fresh");
  });
  it("fresh when bit0 false", async () => {
    const fetcher = async () => Response.json({ bit0: false, bit1: false });
    expect(await deviceCheckGate(envOk, "tok", fetcher)).toBe("fresh");
  });
  it("used when bit0 already set", async () => {
    const fetcher = async () => Response.json({ bit0: true, bit1: false });
    expect(await deviceCheckGate(envOk, "tok", fetcher)).toBe("used");
  });
  it("unavailable on api error", async () => {
    const fetcher = async () => new Response("bad", { status: 500 });
    expect(await deviceCheckGate(envOk, "tok", fetcher)).toBe("unavailable");
  });
  it("prefers dedicated DC_KEY_* secrets when present", async () => {
    let auth = null;
    const fetcher = async (url, init) => { auth = init.headers.authorization; return Response.json({ bit0: false, bit1: false }); };
    const env2 = { ...envOk, DC_KEY_P8: TEST_P8, DC_KEY_ID: "DCKEY67890" };
    expect(await deviceCheckGate(env2, "tok", fetcher)).toBe("fresh");
    // JWT header 里应该带 DC key id（b64url 解开首段验证）
    const header = JSON.parse(Buffer.from(auth.replace(/^Bearer /, "").split(".")[0], "base64url").toString());
    expect(header.kid).toBe("DCKEY67890");
  });
});

describe("deviceCheckMark", () => {
  it("posts update_two_bits with bit0 true", async () => {
    let sent = null;
    const fetcher = async (url, init) => { sent = { url: String(url), body: JSON.parse(init.body) }; return new Response("", { status: 200 }); };
    expect(await deviceCheckMark(envOk, "tok", fetcher)).toBe(true);
    expect(sent.url).toContain("update_two_bits");
    expect(sent.body.bit0).toBe(true);
    expect(sent.body.device_token).toBe("tok");
  });
  it("false when secrets missing or api fails", async () => {
    expect(await deviceCheckMark({}, "tok")).toBe(false);
    const fetcher = async () => new Response("bad", { status: 500 });
    expect(await deviceCheckMark(envOk, "tok", fetcher)).toBe(false);
  });
});
