// 请求级 ASR 热词：火山 auc submit 必须带 request.corpus.context（同音错字在
// 转写层就地消灭——「题图→提图」「图二→图医」）。context 有约 200 token 上限，
// 词表本身的预算约束也在这里钉死，防止后人往里加词加爆。
import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribeResumable } from "../src/miner.js";
import { ASR_HOTWORDS, asrCorpus } from "../src/asr-hotwords.js";
import { fakeEnv } from "./fakes.js";

const AUDIO = "users/u1/VoiceDrop-2026-07-20-120000-30s-mon-am.m4a";

function asrEnv() {
  const e = fakeEnv();
  e.VOLC_ASR_APPID = "appid";
  e.VOLC_ASR_ACCESS_TOKEN = "token";
  e.R2_ACCOUNT_ID = "acc";
  e.R2_ACCESS_KEY_ID = "ak";
  e.R2_SECRET_ACCESS_KEY = "sk";
  return e;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ASR hotwords", () => {
  it("submit body carries corpus.context with the hotword list", async () => {
    let submitBody = null;
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const isSubmit = String(url).endsWith("/submit");
      if (isSubmit) submitBody = JSON.parse(init.body);
      // submit 成功(20000000)，query 一直处理中(20000001)——本测试只关心 submit body
      const code = isSubmit ? "20000000" : "20000001";
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === "x-api-status-code" ? code : "") },
        text: async () => "{}",
      };
    });
    await transcribeResumable(AUDIO, asrEnv(), () => {});
    const ctx = submitBody?.request?.corpus?.context;
    expect(ctx).toBeTruthy();
    const { hotwords } = JSON.parse(ctx);
    expect(hotwords).toEqual(ASR_HOTWORDS.map((word) => ({ word })));
    expect(hotwords.map((h) => h.word)).toContain("题图");
  });

  it("word list stays within Volcano's context budget and has no dupes/blanks", () => {
    expect(ASR_HOTWORDS.length).toBeLessThanOrEqual(100);
    expect(new Set(ASR_HOTWORDS).size).toBe(ASR_HOTWORDS.length);
    for (const w of ASR_HOTWORDS) expect(w.trim()).toBe(w);
    for (const w of ASR_HOTWORDS) expect(w.length).toBeGreaterThan(0);
    // context 上限约 200 token；中文≈1-2 token/字，把总字数压在 150 内留余量
    const chars = ASR_HOTWORDS.join("").length;
    expect(chars).toBeLessThanOrEqual(150);
    expect(asrCorpus().context).toContain("题图");
  });
});
