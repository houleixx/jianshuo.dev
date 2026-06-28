// Resumable ASR: long audio (Volcano takes ~5 min) must NOT be polled to
// completion inside one Worker/DO invocation — that blows the per-invocation
// subrequest limit ("Too many subrequests"). Instead: submit once, persist the
// task to an R2 sidecar, poll a few times per pass, and resume on the next
// alarm pass until done. These tests pin that contract.
import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribeResumable, asrTaskKeyFor, AsrError, ASR_MAX_AGE_MS } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

const AUDIO = "users/u1/VoiceDrop-2026-06-26-120000-67m0s-fri-pm.m4a";

function asrEnv(seed = {}) {
  const e = fakeEnv(seed);
  e.VOLC_ASR_APPID = "appid";
  e.VOLC_ASR_ACCESS_TOKEN = "token";
  e.R2_ACCOUNT_ID = "acc";
  e.R2_ACCESS_KEY_ID = "ak";
  e.R2_SECRET_ACCESS_KEY = "sk";
  return e;
}

// fetch mock that understands Volcano submit/query and returns headers.
// querySeq: array of {code, body} consumed one per /query poll (last repeats).
function asrFetch(querySeq) {
  let q = 0;
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const mk = (code, body) => ({
      ok: true,
      status: 200,
      headers: {
        get: (k) => {
          k = k.toLowerCase();
          if (k === "x-api-status-code") return code;
          if (k === "x-tt-logid") return "logid-1";
          return "";
        },
      },
      text: async () => JSON.stringify(body ?? {}),
    });
    if (u.endsWith("/submit")) return mk("20000000", {});
    if (u.endsWith("/query")) {
      const r = querySeq[Math.min(q, querySeq.length - 1)];
      q++;
      return mk(r.code, r.body);
    }
    return mk("", {});
  };
  fn.calls = calls;
  return fn;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("transcribeResumable", () => {
  it("first pass: submits, writes the task sidecar, returns pending (does not block)", async () => {
    const env = asrEnv();
    vi.stubGlobal("fetch", asrFetch([{ code: "20000001" }])); // 处理中
    const r = await transcribeResumable(AUDIO, env, () => {});
    expect(r.status).toBe("pending");
    const side = env.FILES._store.get(asrTaskKeyFor(AUDIO));
    expect(side).toBeTruthy();
    expect(JSON.parse(side).taskId).toBeTruthy();
  });

  it("resume pass: reuses the saved task (no re-submit), returns done + clears sidecar", async () => {
    const env = asrEnv({
      [asrTaskKeyFor(AUDIO)]: JSON.stringify({ taskId: "tid", logId: "logid-1", submittedAt: Date.now() }),
    });
    const f = asrFetch([
      { code: "20000000", body: { result: { text: "你好这是一段足够长的转写文本内容", utterances: [{ text: "你好", start_time: 0, end_time: 1000 }] } } },
    ]);
    vi.stubGlobal("fetch", f);
    const r = await transcribeResumable(AUDIO, env, () => {});
    expect(r.status).toBe("done");
    expect(r.transcript).toContain("你好");
    expect(env.FILES._store.has(asrTaskKeyFor(AUDIO))).toBe(false); // 清掉 sidecar
    expect(f.calls.some((u) => u.endsWith("/submit"))).toBe(false); // 没有重新提交
  });

  it("deterministic Volcano error code → throws AsrError (caller marks empty)", async () => {
    const env = asrEnv({
      [asrTaskKeyFor(AUDIO)]: JSON.stringify({ taskId: "tid", logId: "logid-1", submittedAt: Date.now() }),
    });
    vi.stubGlobal("fetch", asrFetch([{ code: "45000001" }])); // 非处理中、非成功
    await expect(transcribeResumable(AUDIO, env, () => {})).rejects.toBeInstanceOf(AsrError);
  });

  it("stale task still processing past ASR_MAX_AGE_MS → AsrError('timeout') so it stops looping", async () => {
    const env = asrEnv({
      [asrTaskKeyFor(AUDIO)]: JSON.stringify({ taskId: "tid", logId: "logid-1", submittedAt: Date.now() - ASR_MAX_AGE_MS - 1000 }),
    });
    vi.stubGlobal("fetch", asrFetch([{ code: "20000001" }])); // 还在处理中
    await expect(transcribeResumable(AUDIO, env, () => {})).rejects.toMatchObject({ code: "timeout" });
  });
});
