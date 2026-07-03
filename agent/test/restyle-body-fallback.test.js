// 合并 / 图片 / 独立文章没有口述转写（doc.transcript=""）——重写(restyle)曾在
// miner.js 开头就 {ok:false, reason:"no-transcript"} 硬失败（合并文章 100% 复现）。
// 现在：transcript 为空但文章有正文时，用当前 head 文章的正文当改写来源，
// 走同一套挖矿核心；只有连正文都没有才仍报 no-transcript。
import { describe, it, expect, vi, afterEach } from "vitest";
import { restyleArticle } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

const SUB   = "anon-abc";
const SCOPE = `users/${SUB}/`;
const STEM  = "VoiceDrop-merged-2026-07-03-120000";
const KEY   = `${SCOPE}articles/${STEM}.json`;

// 合并文章的真实落盘形状：versioned schema-3 信封 + transcript:""（writeStandaloneArticle
// 经 Files API 版本化写入后的样子）。
const MERGED_DOC = {
  schema: 3, id: STEM, sourceAudio: `${STEM}.m4a`, transcript: "", srt: "",
  head: 1,
  versions: [{ v: 1, savedAt: "2026-07-03T12:00:00Z", source: "merge",
               articles: [{ title: "合并标题", body: "合并后的正文，讲了两件事。", style: 1 }] }],
  status: "ready", model: "merge",
};

const STYLE_DOC = {
  schema: 3, head: 2,
  versions: [{ v: 1, style: "旧文风" }, { v: 2, style: "新文风：短句、直接。" }],
};

function makeFetch({ articles = [] } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || "GET").toUpperCase(), body: init.body });
    if (u.includes("api.anthropic.com")) {
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ articles }) }] }), text: async () => "" };
    }
    if (u.includes("/files/api/")) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => JSON.stringify({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
  };
  fn.calls = calls;
  return fn;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("restyleArticle: transcript 为空时用正文回退", () => {
  it("合并文章（transcript='' 有正文）重写成功：正文作为改写来源，新版本打 head 风格号", async () => {
    const env = fakeEnv({
      [KEY]: JSON.stringify(MERGED_DOC),
      [`${SCOPE}CLAUDE.json`]: JSON.stringify(STYLE_DOC),
    });
    env.CLAUDE_API_KEY = "sk-ant-test";
    env.FILES_TOKEN = "admin-token";
    const fetchSpy = makeFetch({ articles: [{ title: "重写后", body: "重写后的正文。" }] });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await restyleArticle(env, SCOPE, STEM, null);
    expect(r.ok).toBe(true);

    // 改写来源 = head 文章正文（进了 Claude 的 <transcript>）。
    const claudeCall = fetchSpy.calls.find((c) => c.url.includes("api.anthropic.com"));
    expect(claudeCall).toBeTruthy();
    expect(claudeCall.body).toContain("合并后的正文，讲了两件事。");

    // 新版本经 Files API 写回，articles 打上当前文风 head（v2）。
    const articlePut = fetchSpy.calls.find((c) => c.method === "PUT" && c.url.endsWith(`articles/${SUB}/${STEM}`));
    expect(articlePut).toBeTruthy();
    const doc = JSON.parse(articlePut.body);
    expect(doc.articles[0].title).toBe("重写后");
    expect(doc.articles[0].style).toBe(2);
    // 没有口述转写这个事实不变——不伪造 transcript。
    expect(doc.transcript).toBe("");
  });

  it("transcript 和正文都空 → 仍然 no-transcript", async () => {
    const env = fakeEnv({
      [KEY]: JSON.stringify({ schema: 2, id: STEM, transcript: "", articles: [], status: "ready" }),
      [`${SCOPE}CLAUDE.json`]: JSON.stringify(STYLE_DOC),
    });
    env.CLAUDE_API_KEY = "sk-ant-test";
    const fetchSpy = makeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const r = await restyleArticle(env, SCOPE, STEM, null);
    expect(r).toEqual({ ok: false, reason: "no-transcript" });
    expect(fetchSpy.calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(false);
  });
});
