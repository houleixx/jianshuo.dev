// Tests for the Share-Extension intake: how the miner routes files dropped into
// the R2 inbox by VoiceDrop's share sheet. Two intents, tagged by filename
// prefix — VoiceDrop-mine-* (挖文章) and VoiceDrop-style-* (训练风格) — plus the
// untagged in-app recordings (VoiceDrop-<date>-…) that still mine as audio.
import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyKey, runMine } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

function env(seed = {}, secrets = { CLAUDE_API_KEY: "sk-ant" }) {
  return { ...fakeEnv(seed), ...secrets };
}

function resp(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => "" } };
}

describe("classifyKey — routes inbox files by Share-Extension filename prefix", () => {
  it("in-app recording → audio", () => {
    expect(classifyKey("users/u1/VoiceDrop-2026-06-26-120000-30-fri-am.m4a")).toBe("audio");
  });
  it("shared audio for 挖文章 → audio (ASR path)", () => {
    expect(classifyKey("users/u1/VoiceDrop-mine-1718000000.m4a")).toBe("audio");
  });
  it("shared text / link for 挖文章 → mine-text (no ASR)", () => {
    expect(classifyKey("users/u1/VoiceDrop-mine-1718000000.txt")).toBe("mine-text");
    expect(classifyKey("users/u1/VoiceDrop-mine-1718000000.md")).toBe("mine-text");
  });
  it("shared text / word / link for 训练风格 → style", () => {
    expect(classifyKey("users/u1/VoiceDrop-style-1718000000.txt")).toBe("style");
    expect(classifyKey("users/u1/VoiceDrop-style-1718000000.docx")).toBe("style");
  });
  it("deferred types and foreign keys → null", () => {
    expect(classifyKey("users/u1/VoiceDrop-mine-1718000000.jpg")).toBeNull(); // image-mine deferred
    expect(classifyKey("users/u1/random.txt")).toBeNull();
  });
  it("never re-ingests its own outputs (articles/ + style/ markers)", () => {
    expect(classifyKey("users/u1/articles/VoiceDrop-mine-1718000000.json")).toBeNull();
    expect(classifyKey("users/u1/style/VoiceDrop-style-1718000000.json")).toBeNull();
  });
});

describe("runMine — shared text mines into an article without ASR", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("reads the .txt, runs the LLM (not ASR), and PUTs an article", async () => {
    const fetchSpy = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("openspeech.bytedance.com")) throw new Error("ASR must NOT run for shared text");
      if (u.includes("api.anthropic.com")) {
        return resp({ content: [{ type: "text", text: JSON.stringify({ articles: [{ title: "标题", body: "正文" }] }) }] });
      }
      if (u.includes("/files/api/")) return resp({ ok: true });
      return resp({ error: "no route" }, { ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const e = env({
      "users/u1/VoiceDrop-mine-1718000000.txt":
        "这是一段我直接分享进来的文字，足够长，可以挖成一篇公众号文章。今天想聊聊为什么要做这个分享扩展。",
    });
    await runMine(e);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("api.anthropic.com"))).toBe(true);          // LLM ran
    expect(urls.some((u) => u.includes("openspeech.bytedance.com"))).toBe(false);  // ASR skipped
    const put = fetchSpy.mock.calls.find(
      ([u, init]) => String(u).includes("/files/api/articles/u1/VoiceDrop-mine-1718000000") && init?.method === "PUT",
    );
    expect(put).toBeTruthy();
  });
});

describe("runMine — shared 训练风格 text is collected into the corpus, not mined", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("writes a style sample and makes no LLM / ASR call", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("style collection must not hit the network"); });
    vi.stubGlobal("fetch", fetchSpy);

    const e = env({
      "users/u1/VoiceDrop-style-1718000001.txt": "我写东西喜欢短句，直接下结论，不绕弯子，这就是我的风格。",
    });
    await runMine(e);

    expect(fetchSpy).not.toHaveBeenCalled();
    const sampleRaw = e.FILES._store.get("users/u1/style/VoiceDrop-style-1718000001.json");
    expect(sampleRaw).toBeTruthy();
    const sample = JSON.parse(sampleRaw);
    expect(sample.text).toContain("短句");
    expect(sample.type).toBe("txt");
    expect(sample.needsExtraction).toBe(false);
  });
});
