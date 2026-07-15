import { describe, it, expect } from "vitest";
import { runEditTurn, resolveAnchorLine } from "../src/edit-turn.js";
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

// ── 锚点协议：透传 → 校验 + 漂移自愈 → 注入独立上下文行 ──────────────────────
// spec: docs/superpowers/specs/2026-07-16-anchor-protocol-design.md §3/§4

describe("resolveAnchorLine — 校验 + 漂移自愈", () => {
  const rows = [
    { n: 1, kind: "text", text: "第一段" },
    { n: 2, kind: "photo", imgNo: 1, token: "photos/2026-07-01/1.jpg" },
    { n: 3, kind: "text", text: "第三段" },
    { n: 4, kind: "text", text: "重复段" },
    { n: 5, kind: "text", text: "重复段" },
  ];
  const photoKeys = ["photos/2026-07-01/1.jpg"];

  it("① image anchor 合法 → 注入行含 [[photo:<key>]]", () => {
    const line = resolveAnchorLine({ type: "image", key: "photos/2026-07-01/1.jpg" }, { rows, photoKeys });
    expect(line).toContain("用户长按的图片：[[photo:photos/2026-07-01/1.jpg]]");
  });

  it("② image key 不在本文 → 不注入", () => {
    expect(resolveAnchorLine({ type: "image", key: "photos/other/9.jpg" }, { rows, photoKeys })).toBeNull();
  });

  it("③ line anchor 行号+text 一致 → 注入「用户长按的是第 N 行」", () => {
    const line = resolveAnchorLine({ type: "line", line: 1, text: "第一段" }, { rows, photoKeys });
    expect(line).toContain("用户长按的是第 1 行");
    expect(line).toContain("第一段");
  });

  it("④ 行号不符但 text 在正文唯一匹配 → 注入修正后的行号（漂移自愈）", () => {
    const line = resolveAnchorLine({ type: "line", line: 99, text: "第三段" }, { rows, photoKeys });
    expect(line).toContain("用户长按的是第 3 行");
  });

  it("⑤ text 无匹配 → 不注入", () => {
    expect(resolveAnchorLine({ type: "line", line: 1, text: "不存在的文本" }, { rows, photoKeys })).toBeNull();
  });

  it("⑤ text 多处匹配（行号也不一致）→ 不注入", () => {
    expect(resolveAnchorLine({ type: "line", line: 1, text: "重复段" }, { rows, photoKeys })).toBeNull();
  });

  it("anchor 缺失/非对象/未知 type → 不注入", () => {
    expect(resolveAnchorLine(null, { rows, photoKeys })).toBeNull();
    expect(resolveAnchorLine(undefined, { rows, photoKeys })).toBeNull();
    expect(resolveAnchorLine("bogus", { rows, photoKeys })).toBeNull();
    expect(resolveAnchorLine({ type: "bogus" }, { rows, photoKeys })).toBeNull();
  });
});

describe("runEditTurn — anchor 注入（varLines）", () => {
  const BODY = ["第一段", "[[photo:photos/2026-07-01/1.jpg]]", "第三段"].join("\n\n");
  async function runWith(anchor) {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "底稿", articles: [{ title: "T", body: BODY }] }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "改好了" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e-anchor",
      instruction: "把这张图重画成水彩", images: [], system: "SYS", history: [], callClaude,
      anchor,
    });
    const userMsg = seen.messages.find((m) => m.role === "user");
    return userMsg.content.map((b) => b.text || "").join("\n");
  }

  it("① 合法 image anchor → prompt 含「用户长按的图片：[[photo:<key>]]」", async () => {
    const text = await runWith({ type: "image", key: "photos/2026-07-01/1.jpg" });
    expect(text).toContain("用户长按的图片：[[photo:photos/2026-07-01/1.jpg]]");
  });

  it("② image key 不在本文 → 不注入（无「用户长按」字样）", async () => {
    const text = await runWith({ type: "image", key: "photos/nope/9.jpg" });
    expect(text).not.toContain("用户长按");
  });

  it("③ line anchor 行号+text 一致 → 注入「用户长按的是第 N 行」", async () => {
    const text = await runWith({ type: "line", line: 1, text: "第一段" });
    expect(text).toContain("用户长按的是第 1 行");
  });

  it("④ 行号漂移但 text 唯一匹配 → 注入修正后的行号", async () => {
    const text = await runWith({ type: "line", line: 99, text: "第三段" });
    expect(text).toContain("用户长按的是第 3 行");
  });

  it("⑤ text 无匹配/多处匹配 → 不注入", async () => {
    const text = await runWith({ type: "line", line: 1, text: "查无此段" });
    expect(text).not.toContain("用户长按");
  });

  it("⑥ 无 anchor → prompt 与「显式传 anchor:null」逐字节一致（回归锁）", async () => {
    const withNone = await runWith(undefined);
    const withNull = await runWith(null);
    expect(withNone).toBe(withNull);
    expect(withNone).not.toContain("用户长按");
    // 逐字节对齐现状结构：正文照常内联编号出现，指令紧随其后，两者之间没有
    // 被 anchor 行插进来。
    expect(withNone).toContain("第1行：第一段\n第2行 = 图1：[[photo:photos/2026-07-01/1.jpg]]\n第3行：第三段\n\n\n这次的语音指令：\n把这张图重画成水彩");
  });
});

describe("runEditTurn — anchor 注入（legacy [[photo:N]] 数字标记归一）", () => {
  // 老格式文章：正文标记是裸数字 token（1-based 指向 doc.photos），iOS 长按时
  // 已把数字解析成完整相对 key 放进 anchor.key —— photoKeys 必须做两代格式归一，
  // 否则老文章的 image anchor 会被「宁缺勿错」静默丢弃（多图老文章长按精确命中
  // 是本项目的验收金标准）。
  async function runLegacy({ body, photos, anchor }) {
    const env = fakeEnv({
      "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "底稿", photos, articles: [{ title: "T", body }] }),
    });
    let seen;
    const callClaude = async (req) => { seen = req; return { content: [{ type: "text", text: "改好了" }] }; };
    await runEditTurn({
      env, scope: "users/u/", articleKey: "users/u/articles/s.json",
      token: "t", origin: "https://jianshuo.dev", editId: "e-legacy",
      instruction: "把这张图重画成水彩", images: [], system: "SYS", history: [], callClaude,
      anchor,
    });
    return seen.messages.find((m) => m.role === "user").content.map((b) => b.text || "").join("\n");
  }

  it("legacy 数字标记 + anchor.key=完整相对 key → 经 doc.photos 归一后注入成功", async () => {
    const text = await runLegacy({
      body: "第一段\n\n[[photo:1]]\n\n[[photo:2]]",
      photos: ["photos/x/1-abc.jpg", "photos/x/2-def.jpg"],
      anchor: { type: "image", key: "photos/x/2-def.jpg" },
    });
    expect(text).toContain("用户长按的图片：[[photo:photos/x/2-def.jpg]]");
  });

  it("越界数字标记（doc.photos 没有对应项）不炸，anchor 校验不过 → 不注入", async () => {
    const text = await runLegacy({
      body: "第一段\n\n[[photo:9]]",
      photos: ["photos/x/1-abc.jpg"],
      anchor: { type: "image", key: "photos/x/1-abc.jpg" },
    });
    // [[photo:9]] 越界被丢弃；photos/x/1-abc.jpg 没有被正文任何标记引用 → 不注入。
    expect(text).not.toContain("用户长按");
  });

  it("doc.photos 缺失（新格式文章）时数字标记安全丢弃、相对 key 标记照常命中", async () => {
    const text = await runLegacy({
      body: "第一段\n\n[[photo:1]]\n\n[[photo:photos/y/3-ghi.jpg]]",
      photos: undefined,
      anchor: { type: "image", key: "photos/y/3-ghi.jpg" },
    });
    expect(text).toContain("用户长按的图片：[[photo:photos/y/3-ghi.jpg]]");
  });
});
