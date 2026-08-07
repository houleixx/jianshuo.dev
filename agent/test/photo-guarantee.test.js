// 录音期间的照片一张都不能丢：初次挖矿写盘前 fresh 重列本 session 的 photos/<ts>/，
// 凡正文没引用的 [[photo:key]] 按序补到最后一篇末尾。Pins:
//   - ensurePhotoKeys: 缺的补、全的原样、顺序保持
//   - 有语音挖矿：模型漏插标记 → 写盘的 doc 里标记被补回
//   - 竞态：照片不在跑批快照 allKeys 里、只在 R2 里（ASR 期间才传完）→ 也被补回
import { describe, it, expect, vi, afterEach } from "vitest";
import { mineOneAudio, ensurePhotoKeys, photoKeysIn } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

const SUB   = "anon-abc";
const SCOPE = `users/${SUB}/`;
const STEM  = "VoiceDrop-2026-07-01-101010-1s-周三-上午";
const AUDIO = `${SCOPE}${STEM}.m4a`;
const REL1  = "photos/2026-07-01-101010/3-a1b.jpg";
const REL2  = "photos/2026-07-01-101010/9-c2d.jpg";
const KEY1  = `${SCOPE}${REL1}`;
const KEY2  = `${SCOPE}${REL2}`;

function envWithPhotos(seed = {}) {
  const e = fakeEnv(seed);
  const rawGet = e.FILES.get.bind(e.FILES);
  e.FILES.get = async (key) => {
    const obj = await rawGet(key);
    if (!obj) return null;
    const v = e.FILES._store.get(key);
    return { ...obj, arrayBuffer: async () => {
      const body = new TextEncoder().encode(v);
      // 照片键补上真 JPEG 魔数——loadPhoto 现在按字节嗅探格式，认不出会跳过该图
      if (!key.includes("photos/")) return body.buffer;
      const u = new Uint8Array(3 + body.length);
      u.set([0xff, 0xd8, 0xff]); u.set(body, 3);
      return u.buffer;
    } };
  };
  e.R2_ACCOUNT_ID = "acc";
  e.R2_ACCESS_KEY_ID = "ak";
  e.R2_SECRET_ACCESS_KEY = "sk";
  e.VOLC_ASR_APPID = "appid";
  e.VOLC_ASR_ACCESS_TOKEN = "token";
  e.FILES_TOKEN = "admin-token";
  return e;
}

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

describe("ensurePhotoKeys", () => {
  it("缺的 key 按序补到最后一篇末尾", () => {
    const out = ensurePhotoKeys([REL1, REL2], [
      { title: "A", body: "第一篇。" },
      { title: "B", body: `第二篇。\n\n[[photo:${REL1}]]` },
    ]);
    expect(out[0].body).toBe("第一篇。");
    expect(out[1].body).toContain(`[[photo:${REL1}]]`);
    expect(out[1].body.trimEnd().endsWith(`[[photo:${REL2}]]`)).toBe(true);
  });

  it("全都在 → 原样返回（不重复补）", () => {
    const arts = [{ title: "A", body: `x\n\n[[photo:${REL1}]]\n\n[[photo:${REL2}]]` }];
    const out = ensurePhotoKeys([REL1, REL2], arts);
    expect(photoKeysIn(out)).toEqual([REL1, REL2]);
    expect(out[0].body).toBe(arts[0].body);
  });

  it("空文章数组 / 空 key 列表都安全", () => {
    expect(ensurePhotoKeys([REL1], [])).toEqual([]);
    const arts = [{ title: "A", body: "x" }];
    expect(ensurePhotoKeys([], arts)[0].body).toBe("x");
  });
});

describe("mineOneAudio: 初次挖矿照片保底", () => {
  it("模型漏插标记 → 写盘时补回全部 session 照片", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [KEY1]: "jpg1", [KEY2]: "jpg2" });
    const fetchSpy = makeFetch({
      transcriptText: "今天走了很远的路，看到很多有意思的东西，随手拍了几张照片。",
      // 模型只引用了第一张，漏了第二张
      articles: [{ title: "路上", body: `走了很远。\n\n[[photo:${REL1}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUDIO, [AUDIO, KEY1, KEY2], {}, env);
    expect(r).toBe("mined");

    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();
    const doc = JSON.parse(articlePut.body);
    expect(doc.articles[0].body).toContain(`[[photo:${REL1}]]`);
    expect(doc.articles[0].body).toContain(`[[photo:${REL2}]]`);
  });

  it("照片晚到（不在跑批快照 allKeys、只在 R2）→ fresh 重列也能补回", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [KEY1]: "jpg1", [KEY2]: "jpg2" });
    const fetchSpy = makeFetch({
      transcriptText: "今天走了很远的路，看到很多有意思的东西，随手拍了几张照片。",
      articles: [{ title: "路上", body: `走了很远。\n\n[[photo:${REL1}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    // KEY2 不在 allKeys（挖矿开始后才上传完），但在 R2 store 里
    const r = await mineOneAudio(AUDIO, [AUDIO, KEY1], {}, env);
    expect(r).toBe("mined");

    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(articlePut.body);
    expect(doc.articles[0].body).toContain(`[[photo:${REL2}]]`);
  });

  it("看图模式（无语音）也补回漏掉的照片", async () => {
    const env = envWithPhotos({ [AUDIO]: "audiobytes", [KEY1]: "jpg1", [KEY2]: "jpg2" });
    const fetchSpy = makeFetch({
      transcriptText: "",
      articles: [{ title: "图", body: `随手拍。\n\n[[photo:${REL1}]]` }],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await mineOneAudio(AUDIO, [AUDIO, KEY1, KEY2], {}, env);
    expect(r).toBe("mined");

    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    const doc = JSON.parse(articlePut.body);
    expect(doc.articles[0].body).toContain(`[[photo:${REL1}]]`);
    expect(doc.articles[0].body).toContain(`[[photo:${REL2}]]`);
  });
});
