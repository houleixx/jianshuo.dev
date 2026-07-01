// 无语音 + 有照片 → vision 挖图: when ASR finds no speech but the recording carries
// session photos (or an in-app "只拍照不说话" take), the miner writes a short 图文
// article via Claude vision (IMAGE_ONLY_SYSTEM) instead of marking it .empty. Pins:
//   - photos present + vision succeeds → article written with [[photo:<key>]], no .empty
//   - no photos → unchanged .empty(no-speech) behavior
import { describe, it, expect, vi, afterEach } from "vitest";
import { mineOneAudio } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

const SUB   = "anon-abc";
const SCOPE = `users/${SUB}/`;
const STEM  = "VoiceDrop-2026-07-01-101010-1s-周三-上午";
const AUDIO = `${SCOPE}${STEM}.m4a`;
const PHOTO_REL = "photos/2026-07-01-101010/0-a1b.jpg";
const PHOTO_KEY = `${SCOPE}${PHOTO_REL}`;

// fakeEnv's FILES.get doesn't return arrayBuffer() (loadPhoto needs it for images) —
// wrap it so binary keys (photos/*) get an arrayBuffer-capable object too.
function envWithPhotos(seed = {}) {
  const e = fakeEnv(seed);
  const rawGet = e.FILES.get.bind(e.FILES);
  e.FILES.get = async (key) => {
    const obj = await rawGet(key);
    if (!obj) return null;
    const v = e.FILES._store.get(key);
    return { ...obj, arrayBuffer: async () => new TextEncoder().encode(v).buffer };
  };
  e.R2_ACCOUNT_ID = "acc";
  e.R2_ACCESS_KEY_ID = "ak";
  e.R2_SECRET_ACCESS_KEY = "sk";
  e.VOLC_ASR_APPID = "appid";
  e.VOLC_ASR_ACCESS_TOKEN = "token";
  e.FILES_TOKEN = "admin-token";
  return e;
}

const MODEL_CFG = { providerKey: "anthropic", provider: "anthropic", model: "claude-opus-4-8", baseUrl: "", apiKey: "sk-ant-test" };

// Combined router for ASR (Volcano submit/query) + Claude + the Files article API,
// same style as test/asr-resumable.test.js + test/share-routing.test.js.
function makeFetch({ transcriptText = "", articles = [] } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
    const withHeader = (code, body) => ({
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === "x-api-status-code" ? code : (k.toLowerCase() === "x-tt-logid" ? "logid-1" : "")) },
      json: async () => body,
      text: async () => JSON.stringify(body ?? {}),
    });
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/submit")) return withHeader("20000000", {});
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/query")) {
      return withHeader("20000000", { result: { text: transcriptText, utterances: [] }, audio_info: { duration: 1000 } });
    }
    if (u.includes("api.anthropic.com")) {
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ articles }) }] }), text: async () => "" };
    }
    if (u.includes("/files/api/")) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({ error: "no route" }), text: async () => "no route" };
  };
  fn.calls = calls;
  return fn;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("mineOneAudio: 无语音 + 有照片 → vision", () => {
  it("ASR 空但有照片时写出含 [[photo]] 的文章而非 .empty", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makeFetch({
      transcriptText: "",
      articles: [{ title: "午后的三张照片", body: `随手拍。\n\n[[photo:${PHOTO_REL}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const allKeys = [AUDIO, PHOTO_KEY];
    const r = await mineOneAudio(AUDIO, allKeys, {}, env, MODEL_CFG);
    expect(r).toBe("mined");

    // Vision (Claude) ran; no .empty PUT was made.
    expect(fetchSpy.calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(true);
    const emptyPut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.includes(`articles/${SUB}/${STEM}/empty`));
    expect(emptyPut).toBeUndefined();

    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();
    const doc = JSON.parse(articlePut.body);
    expect(doc.articles[0].body).toContain(`[[photo:${PHOTO_REL}]]`);
    expect(doc.transcript).toBe("");
    expect(doc.status).toBe("ready");
  });

  it("ASR 空且无照片仍写 .empty(no-speech)，不调用 Claude", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes" });
    const fetchSpy = makeFetch({ transcriptText: "", articles: [] });
    vi.stubGlobal("fetch", fetchSpy);

    const allKeys = [AUDIO];
    const r = await mineOneAudio(AUDIO, allKeys, {}, env, MODEL_CFG);
    expect(r).toBe("empty");

    expect(fetchSpy.calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(false);
    const emptyPut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.includes(`articles/${SUB}/${STEM}/empty`));
    expect(emptyPut).toBeTruthy();
    expect(JSON.parse(emptyPut.body)).toMatchObject({ reason: "no-speech" });
  });

  it("ASR 空但有照片，vision 也没写出文章时仍回退 .empty(no-speech)，且 noForce 抑制了二次强制重试", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    // Vision pass returns zero articles — miner should fall back to .empty rather than
    // let mineVariant's normal force-retry fire a second Claude call against an empty transcript.
    const fetchSpy = makeFetch({ transcriptText: "", articles: [] });
    vi.stubGlobal("fetch", fetchSpy);

    const allKeys = [AUDIO, PHOTO_KEY];
    const r = await mineOneAudio(AUDIO, allKeys, {}, env, MODEL_CFG);
    expect(r).toBe("empty");

    const emptyPut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.includes(`articles/${SUB}/${STEM}/empty`));
    expect(emptyPut).toBeTruthy();
    expect(JSON.parse(emptyPut.body)).toMatchObject({ reason: "no-speech" });

    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeUndefined();

    // noForce:true should suppress mineVariant's force-retry, so Claude was hit exactly once
    // (the natural vision pass), not twice.
    const claudeCalls = fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com"));
    expect(claudeCalls.length).toBe(1);
  });

  it("看图模式的 system prompt 不含口述叙事措辞（PHOTO_INSTR 未被追加），但仍保留 [[photo:<key>]] 标记指引", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makeFetch({
      transcriptText: "",
      articles: [{ title: "午后的三张照片", body: `随手拍。\n\n[[photo:${PHOTO_REL}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const allKeys = [AUDIO, PHOTO_KEY];
    const r = await mineOneAudio(AUDIO, allKeys, {}, env, MODEL_CFG);
    expect(r).toBe("mined");

    const claudeCall = fetchSpy.calls.find((c) => c.url.includes("api.anthropic.com"));
    const payload = JSON.parse(claudeCall.body);
    const systemText = Array.isArray(payload.system) ? payload.system.map((b) => b.text).join("") : payload.system;

    // PHOTO_INSTR talks about 口述/"一边说一边拍" (spoken narration) — meaningless (and
    // confusing) on the image-only vision path, where there is no speech at all. It must NOT
    // be appended on top of IMAGE_ONLY_SYSTEM.
    expect(systemText).not.toContain("口述");
    expect(systemText).not.toContain("一边说一边拍");
    // IMAGE_ONLY_SYSTEM already carries its own [[photo:<key>]] marker instruction (point 4),
    // so the model still knows to insert the marker even without PHOTO_INSTR.
    expect(systemText).toContain("[[photo:<key>]]");
    // The photo's actual key still reaches the model via the <photo key="..."> tag that
    // buildMinePrompt emits in the user content regardless of photoInstr.
    const userTexts = payload.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(userTexts).toContain(`key="${PHOTO_REL}"`);
  });

  it("默认 mine（有语音）行为不变：不受 IMAGE_ONLY_SYSTEM 影响", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes" });
    const fetchSpy = makeFetch({
      transcriptText: "你好这是一段足够长的转写文本内容用来触发正常成文",
      articles: [{ title: "正常成文", body: "正文内容" }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const allKeys = [AUDIO];
    const r = await mineOneAudio(AUDIO, allKeys, {}, env, MODEL_CFG);
    expect(r).toBe("mined");

    const claudeCall = fetchSpy.calls.find((c) => c.url.includes("api.anthropic.com"));
    const payload = JSON.parse(claudeCall.body);
    const systemText = Array.isArray(payload.system) ? payload.system.map((b) => b.text).join("") : payload.system;
    expect(systemText).toContain("你是这段录音的录制者"); // MINE_SYSTEM，不是 IMAGE_ONLY_SYSTEM
  });
});
