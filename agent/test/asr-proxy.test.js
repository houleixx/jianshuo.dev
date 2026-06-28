import { describe, it, expect } from "vitest";
import { buildVolcAsrRequest } from "../src/asr-proxy.js";

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

    expect(req.url).toBe("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel");
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
