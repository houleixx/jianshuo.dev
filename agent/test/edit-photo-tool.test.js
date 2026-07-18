import { vi, describe, it, expect, afterEach } from "vitest";
import { makeEditedKey, runTool } from "../src/tools.js";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";

describe("makeEditedKey", () => {
  it("keeps session dir, new ts, rand suffix, .jpg", () => {
    expect(makeEditedKey("photos/1719900000/1719900000.jpg", 1719999999, "abc"))
      .toBe("photos/1719900000/1719999999-abc.jpg");
  });
  it("falls back to nowMs session when unparseable", () => {
    expect(makeEditedKey("weird", 42, "z9")).toBe("photos/42/42-z9.jpg");
  });
  it("result matches the public /photo key shape after scope prefix", () => {
    const rel = makeEditedKey("photos/abc/def.png", 7, "xy");
    expect("users/sub/" + rel).toMatch(/^users\/[^/]+\/photos\/.+\.(jpe?g|png)$/i);
  });
});

const SCOPE = "users/sub123/";
const ARTICLE_KEY = SCOPE + "articles/VoiceDrop-2026-07-02-000000.json";
const OLD = "photos/171/171.jpg";

function seedDoc() {
  return JSON.stringify({
    transcript: "t",
    articles: [{ title: "标题", body: `第一段。\n[[photo:${OLD}]]\n第二段。` }],
  });
}

async function makeCtx({ grantSuanli = 500 } = {}) {
  const env = fakeEnv({ [ARTICLE_KEY]: seedDoc() });
  env.USAGE = fakeD1(usageSql());
  // seed balance
  const now = 1;
  await env.USAGE.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, 0,0,0,now,now).run();
  await env.USAGE.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, Math.round(grantSuanli/23*1e6), Math.round(grantSuanli/23*1e6), "seed", now, null).run();
  env.PAINT_API_TOKEN = "ptok"; env.PAINT_CALLBACK_TOKEN = "cbtok"; env.PAINT_BASE = "https://paint.test";
  return { env, scope: SCOPE, articleKey: ARTICLE_KEY, token: "utok", origin: "https://vd.test", editId: "e1", articleIndex: 0 };
}

// route fetch: PUT article → capture; POST paint → capture + 202
function stubFetch({ paintStatus = 202 } = {}) {
  const calls = { put: null, paint: null };
  const fn = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes("/files/api/articles/")) { calls.put = { url: u, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u.includes("/api/jobs")) { calls.paint = { url: u, body: JSON.parse(init.body), headers: init.headers }; return { ok: paintStatus === 202, status: paintStatus, json: async () => ({ job_id: "j1" }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("edit_photo tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("swaps marker to a new .jpg key and fires paint with correct body", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch();
    const r = await runTool("edit_photo", { key: OLD, prompt: "make it an ad" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("约 1 分钟完成");
    // article PUT body swapped old→new marker
    const body = calls.put.body.articles[0].body;
    expect(body).not.toContain(`[[photo:${OLD}]]`);
    expect(body).toMatch(/\[\[photo:photos\/171\/\d+-[a-z0-9]+\.jpg\]\]/);
    // paint POST body
    expect(calls.paint.headers.Authorization).toBe("Bearer ptok");
    expect(calls.paint.body.prompt).toBe("make it an ad");
    expect(calls.paint.body.size).toBe("1024x1024");
    expect(calls.paint.body.format).toBe("jpeg");
    expect(calls.paint.body.image_url).toBe(`https://vd.test/files/api/photo/${SCOPE}${OLD}`);
    expect(calls.paint.body.callback_url).toBe("https://vd.test/agent/paint-callback");
    expect(calls.paint.body.callback_token).toBe("cbtok");
    expect(calls.paint.body.callback_meta.oldKey).toBe(OLD);
    // XMP 溯源：口述蒸馏 prompt 属用户隐私不入图，只标来源
    expect(calls.paint.body.xmp_prompt).toBe(false);
    expect(calls.paint.body.xmp_meta).toEqual({ source: "voicedrop" });
    expect(calls.paint.body.callback_meta.newKey).toMatch(/^photos\/171\/\d+-[a-z0-9]+\.jpg$/);
    expect(calls.paint.body.callback_meta.scope).toBe(SCOPE);
  });

  it("rejects when balance < imageCostUY (no paint call)", async () => {
    const ctx = await makeCtx({ grantSuanli: 1 }); // < 1.8
    const calls = stubFetch();
    const r = await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(r.error).toContain("算力不足");
    expect(calls.paint).toBe(null);
  });

  it("errors when key not in body", async () => {
    const ctx = await makeCtx();
    stubFetch();
    const r = await runTool("edit_photo", { key: "photos/zzz/zzz.jpg", prompt: "x" }, ctx);
    expect(r.error).toBe("找不到这张图");
  });

  it("reverts marker when paint submit fails (non-202)", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch({ paintStatus: 500 });
    const r = await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(r.error).toBe("图片服务提交失败");
    // last article PUT reverts to old marker (revert write happened)
    expect(calls.put.body.articles[0].body).toContain(`[[photo:${OLD}]]`);
  });
});

describe("new_photo tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("inserts a new marker into the body and fires paint with NO image_url", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch();
    const r = await runTool("new_photo", { prompt: "a poster", after_line: 0 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("约 1 分钟出现");

    const body = calls.put.body.articles[0].body;
    expect(body).toMatch(/\[\[photo:photos\/.+\.jpg\]\]/);
    // the original marker is untouched, still present
    expect(body).toContain(`[[photo:${OLD}]]`);

    expect(calls.paint.headers.Authorization).toBe("Bearer ptok");
    expect(calls.paint.body.prompt).toBe("a poster");
    expect(calls.paint.body.image_url).toBeUndefined();
    expect(calls.paint.body.callback_meta.oldKey).toBeUndefined();
    expect(calls.paint.body.callback_meta.scope).toBe(SCOPE);
    expect(calls.paint.body.callback_meta.articleKey).toBe(ARTICLE_KEY);
    expect(calls.paint.body.callback_meta.newKey).toMatch(/^photos\/.+\.jpg$/);
  });

  it("rejects when balance < imageCostUY (no paint call)", async () => {
    const ctx = await makeCtx({ grantSuanli: 1 }); // < 1.8
    const calls = stubFetch();
    const r = await runTool("new_photo", { prompt: "x", after_line: 0 }, ctx);
    expect(r.error).toContain("算力不足");
    expect(calls.paint).toBe(null);
  });

  it("passes a valid size through (题图横幅), defaults/falls back to 1024x1024", async () => {
    const ctx = await makeCtx();
    let calls = stubFetch();
    await runTool("new_photo", { prompt: "题图", after_line: 0, size: "1568x640" }, ctx);
    expect(calls.paint.body.size).toBe("1568x640");

    calls = stubFetch();
    await runTool("new_photo", { prompt: "x", after_line: 0 }, ctx);
    expect(calls.paint.body.size).toBe("1024x1024");

    calls = stubFetch();
    await runTool("new_photo", { prompt: "x", after_line: 0, size: "huge; DROP" }, ctx);
    expect(calls.paint.body.size).toBe("1024x1024");
  });

  it("reverts the inserted marker when paint submit fails (non-202)", async () => {
    const ctx = await makeCtx();
    const calls = stubFetch({ paintStatus: 500 });
    const r = await runTool("new_photo", { prompt: "x", after_line: 0 }, ctx);
    expect(r.error).toBe("图片服务提交失败");
    // final PUT'd body no longer contains the new marker — reverted to the original
    expect(calls.put.body.articles[0].body).not.toMatch(/\[\[photo:photos\/(?!171\/171\.jpg).+\.jpg\]\]/);
    expect(calls.put.body.articles[0].body).toBe(`第一段。\n[[photo:${OLD}]]\n第二段。`);
  });
});

// ── 输出尺寸对齐原图比例（相册导入的横竖图不再被 AI 改成方形）──────────────
function sofJpeg(w, h) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0,0,0, 0,0,0, 0,0,0, 0xff, 0xd9]);
}

describe("edit_photo keeps source aspect ratio", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("4:3 原图 → paint size 1024x768", async () => {
    const ctx = await makeCtx();
    ctx.env.FILES._store.set(SCOPE + OLD, sofJpeg(4000, 3000));
    const calls = stubFetch();
    const r = await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.paint.body.size).toBe("1024x768");
  });

  it("3:4 竖图 → paint size 768x1024", async () => {
    const ctx = await makeCtx();
    ctx.env.FILES._store.set(SCOPE + OLD, sofJpeg(3000, 4000));
    const calls = stubFetch();
    await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(calls.paint.body.size).toBe("768x1024");
  });

  it("原图缺失/头解析失败 → 回退 1024x1024（老行为）", async () => {
    const ctx = await makeCtx();   // 不 seed 照片
    const calls = stubFetch();
    await runTool("edit_photo", { key: OLD, prompt: "x" }, ctx);
    expect(calls.paint.body.size).toBe("1024x1024");
  });
});
