// 无语音 + 有照片 → vision 挖图: when ASR finds no speech but the recording carries
// session photos (or an in-app "只拍照不说话" take), the miner writes a short 图文
// article via Claude vision (IMAGE_ONLY_SYSTEM) instead of marking it .empty. Pins:
//   - photos present + vision succeeds → article written with [[photo:<key>]], no .empty
//   - no photos → unchanged .empty(no-speech) behavior
import { describe, it, expect, vi, afterEach } from "vitest";
import { mineOneAudio, restyleArticle } from "../src/miner.js";
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

  it("0 秒静音占位（-0m0s-）跳过 ASR：有照片直接看图成文，不打火山", async () => {
    const STEM0  = "VoiceDrop-2026-07-01-101010-0m0s-周三-上午";
    const AUDIO0 = `${SCOPE}${STEM0}.m4a`;
    const env = envWithPhotos({ [AUDIO0]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makeFetch({
      transcriptText: "不该被用到", // 若真调了 ASR 会拿到这个非空文本，就不会走 vision 了
      articles: [{ title: "图", body: `随手拍。\n\n[[photo:${PHOTO_REL}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUDIO0, [AUDIO0, PHOTO_KEY], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    // 关键：火山 ASR 端点一次都没被调（0 秒被跳过）。
    expect(fetchSpy.calls.some((c) => c.url.includes("openspeech.bytedance.com"))).toBe(false);
    // vision 照常写出图文。
    expect(fetchSpy.calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(true);
    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM0}`));
    expect(articlePut).toBeTruthy();
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

  it("看图成文打上当前文风 head 的 style 字段（chip 显示风格版本）", async () => {
    // 之前看图分支只把文风文本喂进 prompt，落盘却不打 articles[i].style —— iOS chip
    // 显示「选风格」，看起来"没有风格"。现在和正常语音挖矿一样打 head 版本号。
    const env = envWithPhotos({
      [AUDIO]: "audiobytes",
      [PHOTO_KEY]: "jpgbytes",
      [`${SCOPE}CLAUDE.json`]: JSON.stringify({ schema: 3, head: 2, versions: [{ v: 1, style: "旧文风" }, { v: 2, style: "新文风：短句。" }] }),
    });
    const fetchSpy = makeFetch({
      transcriptText: "",
      articles: [{ title: "图", body: `随手拍。\n\n[[photo:${PHOTO_REL}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();
    expect(JSON.parse(articlePut.body).articles[0].style).toBe(2);
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

  it("style-extract 任务：占位音频（文件名 TaskStyleExtract，无 sidecar）→ 蒸馏→写风格版本+介绍文章，清空语料，不打火山", async () => {
    // 类型 tag 在文件名尾 token（TaskStyleExtract），和 VoiceDrop-style-/VoiceDrop-mine- 同一机制。
    const STEM = "VoiceDrop-2026-07-02-100000-0m0s-Thu-Morning-TaskStyleExtract";
    const AUD  = `${SCOPE}${STEM}.m4a`;
    const env = envWithPhotos({
      [AUD]: "silentbytes",
      [`${SCOPE}style/s1.json`]: JSON.stringify({ id: "s1", title: "样本", text: "我写东西偏口语，短句多。".repeat(30) }),   // ≥ MIN_CORPUS_CHARS，过充足性硬闸
    });
    const calls = [];
    const fetchSpy = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
      if (u.includes("api.anthropic.com")) {
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "风格名：口语派\n## 一句话画像\n偏口语、短句。" }], usage: {} }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    };
    fetchSpy.calls = calls;
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUD, [AUD], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    expect(calls.some((c) => c.url.includes("openspeech.bytedance.com"))).toBe(false); // 没打火山 ASR
    expect(env.FILES._store.has(`${SCOPE}CLAUDE.json`)).toBe(true);                    // 写了风格版本
    const articlePut = calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();                                                    // 写了介绍文章
    expect(JSON.parse(articlePut.body).articles[0].title).toContain("口语派");          // 标题含风格名
    expect(JSON.parse(articlePut.body).articles[0].body).toContain("1. 样本");           // 介绍文章列出素材清单
    expect(env.FILES._store.has(`${SCOPE}style/s1.json`)).toBe(false);                  // clearAfter → 语料清空
  });

  it("style-extract 任务：语料只有书名级碎片（不足 MIN_CORPUS_CHARS）→ 写「样本不足」反馈文章，不写风格版本、不清语料、不打 Claude", async () => {
    // anon-15 事故回归：只分享了《送你一颗子弹》书名 → 蒸馏器的「无法蒸馏」说明卡被
    // 存成风格版本并成为生效文风。硬闸后：跳过蒸馏，反馈走文章通道，风格不动。
    const STEM = "VoiceDrop-2026-07-02-110000-0m0s-Thu-Morning-TaskStyleExtract";
    const AUD  = `${SCOPE}${STEM}.m4a`;
    const env = envWithPhotos({
      [AUD]: "silentbytes",
      [`${SCOPE}style/s1.json`]: JSON.stringify({ id: "s1", title: "送你一颗子弹", text: "《送你一颗子弹》" }),
    });
    const calls = [];
    const fetchSpy = async (url, init = {}) => {
      calls.push({ url: String(url), method: (init.method || "GET").toUpperCase(), body: init.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    };
    fetchSpy.calls = calls;
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUD, [AUD], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    expect(calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(false);   // 没打 Claude
    expect(env.FILES._store.has(`${SCOPE}CLAUDE.json`)).toBe(false);              // 没写风格版本
    const articlePut = calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();                                               // 反馈文章写了
    const art = JSON.parse(articlePut.body).articles[0];
    expect(art.title).toBe("样本不足，风格没有更新");
    expect(art.body).toContain("送你一颗子弹");                                    // 列出收到的素材
    expect(art.body).toContain("没有改动你的写作风格");
    expect(env.FILES._store.has(`${SCOPE}style/s1.json`)).toBe(true);             // 语料保留，补够再提
  });
});

// ── imagePipeline 开关（四阶段流水线）────────────────────────────────────────────

const CFG_PIPE = { ...MODEL_CFG, imagePipeline: true };
const REL2 = PHOTO_REL;
const PIPE_CANNED = {
  observe: { images: [{ key: REL2, caption: "拿铁", confidence: 0.9 }], timeline: "", clusters: [], repeated_entities: [] },
  plan: { candidates: [], selected: "A", rejected_because: "", thesis: "t", title_options: [], sections: [], image_role_map: {} },
  write: { articles: [{ title: "初稿", body: `x\n\n[[photo:${REL2}]]` }] },
  review: { articles: [{ title: "流水线终稿", body: `y\n\n[[photo:${REL2}]]` }], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] },
};
// anthropic 依调用次序回放 observe→plan→write→review；其余路由同 makeFetch。
function makePipelineFetch({ failFirstLlm = false } = {}) {
  const calls = []; const seq = ["observe", "plan", "write", "review"]; let llmN = 0;
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
    const withHeader = (code, body) => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "x-api-status-code" ? code : "logid") }, json: async () => body, text: async () => JSON.stringify(body ?? {}) });
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/submit")) return withHeader("20000000", {});
    if (u.includes("openspeech.bytedance.com") && u.endsWith("/query")) return withHeader("20000000", { result: { text: "", utterances: [] }, audio_info: { duration: 1000 } });
    if (u.includes("api.anthropic.com")) {
      llmN++;
      if (failFirstLlm && llmN === 1) return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      // failFirstLlm：observe 失败后流水线整体放弃，后续唯一一次 LLM 是回退的单发
      const stage = failFirstLlm ? undefined : seq[llmN - 1];
      const body = stage ? PIPE_CANNED[stage] : { articles: [{ title: "单发回退", body: `z\n\n[[photo:${REL2}]]` }] };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(body) }], usage: {} }), text: async () => "" };
    }
    if (u.includes("/files/api/")) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
  };
  fn.calls = calls;
  return fn;
}

describe("mineOneAudio: imagePipeline 开关", () => {
  it("开关开：走四阶段流水线，doc 带 vision/plan/quality，文章来自终审稿", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makePipelineFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, CFG_PIPE);
    expect(r).toBe("mined");
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(4);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(put.body);
    expect(doc.articles[0].title).toBe("流水线终稿");
    expect(doc.vision.images[0].key).toBe(REL2);
    expect(doc.plan.thesis).toBe("t");
    expect(doc.quality.overall).toBe(90);
  });
  it("开关开但流水线首调失败：回退单发，doc 无 vision，文章照写", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makePipelineFetch({ failFirstLlm: true });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, CFG_PIPE);
    expect(r).toBe("mined");
    // 1 次失败的 observe + 1 次回退单发 = 2 次 LLM；回退侧文章按 seq 之外的分支给出
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(2);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(put.body);
    expect(doc.vision).toBeUndefined();
    expect(doc.articles.length).toBe(1);
  });
  it("开关关：行为与现行一致（1 次单发调用，doc 无 vision）", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [PHOTO_KEY]: "jpgbytes" });
    const fetchSpy = makeFetch({ transcriptText: "", articles: [{ title: "旧路径", body: `w\n\n[[photo:${REL2}]]` }] });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mineOneAudio(AUDIO, [AUDIO, PHOTO_KEY], {}, env, MODEL_CFG);
    expect(r).toBe("mined");
    expect(fetchSpy.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(1);
    const put = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(JSON.parse(put.body).vision).toBeUndefined();
  });
});

// ── restyleArticle: 图片流水线产物复用观察结果 ─────────────────────────────────────

describe("restyleArticle: 图片流水线产物复用观察结果", () => {
  it("doc.vision/plan 在 → 只打 2 次 LLM（write+review），新版本保留 vision/plan", async () => {
    const articleDoc = { schema: 2, id: STEM, sourceAudio: `${STEM}.m4a`, transcript: "", srt: "", articles: [{ title: "旧", body: "旧文" }], status: "ready", vision: PIPE_CANNED.observe, plan: PIPE_CANNED.plan };
    const styleJson = { head: 2, versions: [{ v: 1, style: "文风一" }, { v: 2, style: "文风二" }] };
    const env = envWithPhotos({
      [`${SCOPE}articles/${STEM}.json`]: JSON.stringify(articleDoc),
      [`${SCOPE}CLAUDE.json`]: JSON.stringify(styleJson),
      [PHOTO_KEY]: "jpgbytes",
      "config/model.json": JSON.stringify({ providerKey: "anthropic", imagePipeline: true }),
    });
    env.CLAUDE_API_KEY = "k";
    const calls = []; let n = 0; const seq = ["write", "review"];
    const fetchSpy = async (url, init = {}) => {
      const u = String(url); calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
      if (u.includes("api.anthropic.com")) {
        const body = PIPE_CANNED[seq[n++]];
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(body) }], usage: {} }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    };
    fetchSpy.calls = calls;
    vi.stubGlobal("fetch", fetchSpy);

    const r = await restyleArticle(env, SCOPE, STEM, 2);
    expect(r.ok).toBe(true);
    const llm = calls.filter((c) => c.url.includes("api.anthropic.com"));
    expect(llm.length).toBe(2);
    // 第 1 调用 = write 阶段：system 含目标文风、不带图片
    const p1 = JSON.parse(llm[0].body);
    const sys1 = Array.isArray(p1.system) ? p1.system.map((b) => b.text).join("") : p1.system;
    expect(sys1).toContain("文风二");
    expect(JSON.stringify(p1)).not.toContain('"type":"image"');
    // 第 2 调用 = review 阶段：带图片
    expect(JSON.stringify(JSON.parse(llm[1].body))).toContain('"type":"image"');
    // 新版本 PUT：文章来自 review 稿、style=2、保留 vision/plan
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(put.body);
    expect(doc.articles[0].title).toBe("流水线终稿");
    expect(doc.articles[0].style).toBe(2);
    expect(doc.vision).toBeTruthy();
    expect(doc.plan).toBeTruthy();
  });
  it("开关关：restyle 走既有 mineVariant 路径（1 次 LLM）", async () => {
    const articleDoc = { schema: 2, id: STEM, sourceAudio: `${STEM}.m4a`, transcript: "", srt: "", articles: [{ title: "旧", body: "旧文" }], status: "ready", vision: PIPE_CANNED.observe, plan: PIPE_CANNED.plan };
    const styleJson = { head: 2, versions: [{ v: 2, style: "文风二" }] };
    const env = envWithPhotos({
      [`${SCOPE}articles/${STEM}.json`]: JSON.stringify(articleDoc),
      [`${SCOPE}CLAUDE.json`]: JSON.stringify(styleJson),
      [PHOTO_KEY]: "jpgbytes",
    });
    env.CLAUDE_API_KEY = "k";
    const calls = [];
    const fetchSpy = async (url, init = {}) => {
      const u = String(url); calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
      if (u.includes("api.anthropic.com")) {
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ articles: [{ title: "单发重写", body: "x" }] }) }], usage: {} }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    };
    fetchSpy.calls = calls;
    vi.stubGlobal("fetch", fetchSpy);

    const r = await restyleArticle(env, SCOPE, STEM, 2);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(1);
  });
});
