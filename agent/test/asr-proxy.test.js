import { describe, it, expect } from "vitest";
import { buildVolcAsrRequest, toSendablePayload } from "../src/asr-proxy.js";

describe("buildVolcAsrRequest", () => {
  it("forwards a WebSocket upgrade to Volc ASR using server-side credentials", () => {
    const clientReq = new Request("https://jianshuo.dev/agent/asr", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer app-token",
      },
    });
    const req = buildVolcAsrRequest(clientReq, {
      VOLC_ASR_APPID: "appid-1",
      VOLC_ASR_ACCESS_TOKEN: "token-1",
    });

    expect(req.url).toBe("https://openspeech.bytedance.com/api/v3/sauc/bigmodel");
    expect(req.headers.get("Upgrade")).toBe("websocket");
    expect(req.headers.get("Authorization")).toBeNull();
    expect(req.headers.get("X-Api-App-Key")).toBe("appid-1");
    expect(req.headers.get("X-Api-Access-Key")).toBe("token-1");
    expect(req.headers.get("X-Api-Resource-Id")).toBe("volc.bigasr.sauc.duration");
    expect(req.headers.get("X-Api-Connect-Id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("fails fast when Volc ASR secrets are missing", () => {
    expect(() => buildVolcAsrRequest(new Request("https://jianshuo.dev/agent/asr"), {}))
      .toThrow("VOLC_ASR_APPID or VOLC_ASR_ACCESS_TOKEN is not configured");
  });
});

describe("toSendablePayload (binary frames must NOT coerce to '[object Blob]')", () => {
  it("passes strings through unchanged", async () => {
    expect(await toSendablePayload("hello")).toBe("hello");
  });

  it("passes an ArrayBuffer through unchanged (no Blob coercion)", async () => {
    const ab = new Uint8Array([0x11, 0x22, 0x33]).buffer;
    expect(await toSendablePayload(ab)).toBe(ab);
  });

  it("converts a Blob to its bytes instead of the string '[object Blob]'", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const blob = { arrayBuffer: async () => bytes.buffer }; // Blob-like
    const out = await toSendablePayload(blob);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(out)).toEqual(bytes);
    expect(String(out)).not.toBe("[object Blob]");
  });
});

// ── injectAsrHotwords：sauc full client request 帧注入服务端热词 ─────────────
// 帧样本严格按 App 的 VolcASRProtocol.swift 构造（gzip JSON、flags=POS_SEQUENCE、seq=1）。
import { gzipSync, gunzipSync } from "node:zlib";
import { injectAsrHotwords } from "../src/asr-proxy.js";
import { ASR_HOTWORDS } from "../src/asr-hotwords.js";

function volcFrame({ messageType, flags, serialization, compression, sequence, payload }) {
  const head = [
    (0b0001 << 4) | 0b0001,            // version 1, header size 1 (×4 bytes)
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ];
  const seq = flags ? 4 : 0;
  const buf = new Uint8Array(4 + seq + 4 + payload.length);
  buf.set(head, 0);
  const dv = new DataView(buf.buffer);
  if (seq) dv.setInt32(4, sequence);
  dv.setUint32(4 + seq, payload.length);
  buf.set(payload, 4 + seq + 4);
  return buf.buffer;
}

function appFullClientFrame(reqJson = {}) {
  const payload = {
    user: { uid: "voicedrop-edit" },
    audio: { format: "pcm", rate: 16000, bits: 16, channel: 1, codec: "raw" },
    request: { model_name: "bigmodel", enable_punc: true, enable_itn: true, show_utterances: true, ...reqJson },
  };
  return volcFrame({
    messageType: 0b0001, flags: 0b0001, serialization: 0b0001, compression: 0b0001,
    sequence: 1, payload: gzipSync(Buffer.from(JSON.stringify(payload))),
  });
}

describe("injectAsrHotwords (streaming ASR gets the same hotwords as batch)", () => {
  it("injects corpus.context into the full client request, preserving header/seq and app fields", async () => {
    const out = await injectAsrHotwords(appFullClientFrame());
    const u = new Uint8Array(out);
    expect([...u.slice(0, 8)]).toEqual([0x11, 0x11, 0x11, 0x00, 0, 0, 0, 1]); // 头+seq 原样
    const size = new DataView(out, 8, 4).getUint32(0);
    expect(size).toBe(u.length - 12);
    const req = JSON.parse(gunzipSync(Buffer.from(u.slice(12))).toString());
    expect(req.user.uid).toBe("voicedrop-edit");          // App 字段全保留
    expect(req.audio.rate).toBe(16000);
    expect(req.request.enable_punc).toBe(true);
    const { hotwords } = JSON.parse(req.request.corpus.context);
    expect(hotwords.map((h) => h.word)).toEqual(ASR_HOTWORDS);
  });

  it("keeps app-set corpus fields, only adding/overriding context", async () => {
    const out = await injectAsrHotwords(appFullClientFrame({ corpus: { boosting_table_name: "t1" } }));
    const u = new Uint8Array(out);
    const req = JSON.parse(gunzipSync(Buffer.from(u.slice(12))).toString());
    expect(req.request.corpus.boosting_table_name).toBe("t1");
    expect(req.request.corpus.context).toContain("题图");
  });

  it("passes audio-only frames through untouched (same reference)", async () => {
    const audio = volcFrame({
      messageType: 0b0010, flags: 0b0001, serialization: 0b0000, compression: 0b0001,
      sequence: 2, payload: gzipSync(Buffer.from([1, 2, 3])),
    });
    expect(await injectAsrHotwords(audio)).toBe(audio);
  });

  it("passes strings and malformed/truncated frames through unchanged", async () => {
    expect(await injectAsrHotwords("ping")).toBe("ping");
    const short = new Uint8Array([0x11, 0x11]).buffer;
    expect(await injectAsrHotwords(short)).toBe(short);
    const lying = appFullClientFrame();
    new DataView(lying, 8, 4).setUint32(0, 999999); // 声称的 payload 比实际长
    expect(await injectAsrHotwords(lying)).toBe(lying);
  });

  it("handles an uncompressed JSON full client request too", async () => {
    const frame = volcFrame({
      messageType: 0b0001, flags: 0b0001, serialization: 0b0001, compression: 0b0000,
      sequence: 1, payload: Buffer.from(JSON.stringify({ request: {} })),
    });
    const out = new Uint8Array(await injectAsrHotwords(frame));
    const req = JSON.parse(Buffer.from(out.slice(12)).toString());
    expect(req.request.corpus.context).toContain("题图");
  });
});
