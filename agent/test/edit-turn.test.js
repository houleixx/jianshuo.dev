import { describe, it, expect } from "vitest";
import { runEditTurn } from "../src/edit-turn.js";
import { fakeEnv, fakeFetch } from "./fakes.js";

// A callClaude that drives exactly one write_article tool call, then stops.
function writeArticleClaude(articles) {
  let step = 0;
  return async () => {
    step++;
    if (step === 1) {
      return { content: [
        { type: "text", text: "改好了" },
        { type: "tool_use", id: "tu1", name: "write_article", input: { articles } },
      ] };
    }
    return { content: [{ type: "text", text: "改好了" }] };
  };
}

describe("runEditTurn", () => {
  it("runs the loop, writes the doc with lastEditId, returns the client-ready article", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "原文", articles: [{ title: "old", body: "old body" }] }),
    });
    // Route the write_article PUT through the real versioned writer so the fake
    // R2 actually updates and we can read the result back.
    const { writeArticleDoc } = await import("../../functions/lib/article-store.js");
    const fetchFake = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s": async ({ init }) => {
        await writeArticleDoc(env, "users/u/articles/s.json", JSON.parse(init.body), "agent");
        return { ok: true, body: { ok: true } };
      },
    });
    const orig = globalThis.fetch; globalThis.fetch = fetchFake;
    try {
      const res = await runEditTurn({
        env, scope: "users/u/", articleKey: "users/u/articles/s.json",
        token: "t", origin: "https://jianshuo.dev", editId: "edit-1",
        instruction: "把标题改成 NEW", images: [], system: "SYS", history: [],
        callClaude: writeArticleClaude([{ title: "NEW", body: "new body" }]),
      });
      expect(res.ok).toBe(true);
      expect(res.reply).toBe("改好了");
      // Client-ready doc carries top-level articles + the stamped id.
      expect(res.article.articles[0].title).toBe("NEW");
      expect(res.article.lastEditId).toBe("edit-1");
    } finally { globalThis.fetch = orig; }
  });

  it("reports hadError + ok:false when the doc is missing", async () => {
    const env = fakeEnv({});
    const res = await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/missing.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e", instruction: "x",
      images: [], system: "SYS", history: [], callClaude: async () => ({ content: [] }),
    });
    expect(res.ok).toBe(false);
    expect(res.hadError).toBe(true);
    expect(res.article).toBeNull();
  });

  it("is idempotent on its own — skips the model when the doc already carries this editId", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "原文", lastEditId: "edit-1", articles: [{ title: "已改", body: "已改 body" }] }),
    });
    let claudeCalls = 0;
    const res = await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "edit-1",
      instruction: "把标题改成 NEW", images: [], system: "SYS", history: [],
      callClaude: async () => { claudeCalls++; return { content: [] }; },
    });
    expect(claudeCalls).toBe(0);                 // model never invoked
    expect(res.ok).toBe(true);
    expect(res.reply).toBe("");
    expect(res.article.articles[0].title).toBe("已改"); // unchanged
  });

  it("puts static system + transcript into cached system blocks, keeping the user message volatile-only", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "我的口述转写底稿", articles: [{ title: "T", body: "一\n\n二" }] }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "改好了" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e1",
      instruction: "把第2行删掉", images: [], system: "STATIC-SYS", history: [], callClaude,
    });
    // system = two ephemeral-cached blocks: [static instructions, transcript].
    expect(Array.isArray(seen.system)).toBe(true);
    expect(seen.system).toHaveLength(2);
    expect(seen.system[0]).toEqual({ type: "text", text: "STATIC-SYS", cache_control: { type: "ephemeral" } });
    expect(seen.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(seen.system[1].text).toContain("我的口述转写底稿");
    // The user message is volatile-only — transcript no longer rides in it.
    // (Grab it by role: the loop mutates `messages` in place, appending the
    // assistant reply to the same array after the call.)
    const userMsg = seen.messages.find((m) => m.role === "user");
    const userText = userMsg.content.map((b) => b.text || "").join("\n");
    expect(userText).not.toContain("我的口述转写底稿");
    expect(userText).toContain("这次的语音指令：");
    expect(userText).toContain("把第2行删掉");
  });

  it("shows the edited article inline-numbered as ONE copy — no duplicate clean body / 行号对照 table", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "底稿", articles: [{ title: "T", body: "甲\n\n乙\n\n丙" }] }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "改好了" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e-inline",
      instruction: "把第2行删掉", images: [], system: "SYS", history: [], callClaude,
    });
    const userMsg = seen.messages.find((m) => m.role === "user");
    const userText = userMsg.content.map((b) => b.text || "").join("\n");
    // The body is present once, inline-numbered.
    expect(userText).toContain("第1行：甲");
    expect(userText).toContain("第2行：乙");
    expect(userText).toContain("第3行：丙");
    // The old separate 行号对照 table header is gone.
    expect(userText).not.toContain("行号对照");
    // No second clean copy of the body: 乙 appears exactly once (only in 第2行：乙).
    expect(userText.match(/乙/g)?.length).toBe(1);
  });

  it("injects the shared-prompt block when the instruction carries a 7-digit share code", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "底稿", articles: [{ title: "T", body: "甲" }] }),
      "shares/4563566": JSON.stringify({ type: "prompt", sub: "o", itemId: "x", label: "更毒舌", instruction: "改得更毒舌。" }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "改好了" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e-share",
      instruction: "用4563566改这段", images: [], system: "SYS", history: [], callClaude,
    });
    const userText = seen.messages.find((m) => m.role === "user").content.map((b) => b.text || "").join("\n");
    expect(userText).toContain("【分享提示词开始】");
    expect(userText).toContain("改得更毒舌。");
    expect(userText).toContain("更毒舌");
  });

  it("does NOT inject anything for a plain instruction without a share code", async () => {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "底稿", articles: [{ title: "T", body: "甲" }] }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "好" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e-noshare",
      instruction: "把标题改短", images: [], system: "SYS", history: [], callClaude,
    });
    const userText = seen.messages.find((m) => m.role === "user").content.map((b) => b.text || "").join("\n");
    expect(userText).not.toContain("【分享提示词开始】");
    expect(userText).not.toContain("系统备注");
  });
});

// ── 插图给模型：key-only → 服务端拉 320 边缘缩图；老 app 的 data 原样透传 ──────

describe("runEditTurn images — 服务端 320 缩图", () => {
  const DOC = { schema: 2, createdAt: 1, transcript: "原文", articles: [{ title: "T", body: "B" }] };

  // 能回 headers/arrayBuffer 的图片响应（fakeFetch 只会 JSON，这里自己搭）。
  function imageResp(bytes) {
    return { ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => new TextEncoder().encode(bytes).buffer };
  }

  async function runWith({ images, edgeOK }) {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify(DOC),
    });
    // fakeEnv 的 arrayBuffer 返回原字符串（历史行为，别的测试依赖它）；照片字节
    // 要过 bufToB64，这里单独给这个 key 一个真 ArrayBuffer。
    const realGet = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (k) => k === "users/u/photos/7/1.jpg"
      ? { arrayBuffer: async () => new TextEncoder().encode("RAWJPEG").buffer }
      : realGet(k);
    let captured = null;
    const callClaude = async (params) => { captured = params; return { content: [{ type: "text", text: "好" }] }; };
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/cdn-cgi/image/")) {
        return edgeOK ? imageResp("EDGE320") : { ok: false, status: 404, headers: { get: () => null } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
    };
    try {
      await runEditTurn({
        env, scope: "users/u/", articleKey: "users/u/articles/s.json",
        token: "t", origin: "https://jianshuo.dev", editId: "e-img",
        instruction: "插图", images, system: "SYS", history: [], callClaude,
      });
    } finally { globalThis.fetch = orig; }
    return captured;
  }

  it("key-only 图片 → 拉 320 边缘缩图 base64 给模型", async () => {
    const p = await runWith({ images: [{ key: "photos/7/1.jpg" }], edgeOK: true });
    const imgs = p.messages.find((m) => m.role === "user").content.filter((b) => b.type === "image");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].source.data).toBe(btoa("EDGE320"));
  });

  it("老 app 带 data → 原样透传，不去拉边缘缩图", async () => {
    const p = await runWith({ images: [{ key: "photos/7/1.jpg", data: "LEGACY64" }], edgeOK: false });
    const imgs = p.messages.find((m) => m.role === "user").content.filter((b) => b.type === "image");
    expect(imgs[0].source.data).toBe("LEGACY64");
  });

  it("边缘缩图 404（zone 没开）→ 回退 R2 原图", async () => {
    const p = await runWith({ images: [{ key: "photos/7/1.jpg" }], edgeOK: false });
    const imgs = p.messages.find((m) => m.role === "user").content.filter((b) => b.type === "image");
    expect(imgs).toHaveLength(1);
    expect(atob(imgs[0].source.data)).toBe("RAWJPEG");
  });
});
