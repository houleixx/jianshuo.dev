// 2026-07-24 语音编辑提速三件套的行为锁：
//   ① loop：edit_photo / new_photo 成功后短路（不再多跑一轮模型只为一句确认）
//   ② edit-turn：长按菜单 kind=image prompt + 图片锚点 → 确定性直通 edit_photo，零 LLM
//   ③ edit-turn：写后校验只花在高风险编辑上（write_article / 带锚点 / 多 op），
//      单 op 无锚点的小改不再多付一次 haiku 往返
import { vi, describe, it, expect, afterEach } from "vitest";
import { runEditTurn } from "../src/edit-turn.js";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";

const SCOPE = "users/sub123/";
const ARTICLE_KEY = SCOPE + "articles/VoiceDrop-2026-07-02-000000.json";
const OLD = "photos/171/171.jpg";

function seedDoc() {
  return JSON.stringify({
    transcript: "t",
    articles: [{ title: "标题", body: `第一段。\n[[photo:${OLD}]]\n第二段。` }],
  });
}

async function makeArgs(overrides = {}) {
  const env = fakeEnv({ [ARTICLE_KEY]: seedDoc() });
  env.USAGE = fakeD1(usageSql());
  const now = 1;
  await env.USAGE.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, 0, 0, 0, now, now).run();
  await env.USAGE.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, Math.round(500 / 23 * 1e6), Math.round(500 / 23 * 1e6), "seed", now, null).run();
  env.PAINT_API_TOKEN = "ptok"; env.PAINT_CALLBACK_TOKEN = "cbtok"; env.PAINT_BASE = "https://paint.test";
  return {
    env, scope: SCOPE, articleKey: ARTICLE_KEY, token: "utok", origin: "https://vd.test",
    editId: "e1", instruction: "把这张图做成白边贴纸", images: [], articleIndex: 0,
    system: "SYS", history: [],
    callClaude: async () => { throw new Error("LLM must not be called on the fast path"); },
    ...overrides,
  };
}

// route fetch: PUT article（真落盘回 fakeEnv，这样 edit-turn 结尾重读能看到换过的
// 标记）；POST paint → 202
function stubFetch(env) {
  const calls = { paint: null };
  const fn = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes("/files/api/articles/")) {
      await env.FILES.put(ARTICLE_KEY, init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes("/api/jobs")) { calls.paint = { url: u, body: JSON.parse(init.body) }; return { ok: true, status: 202, json: async () => ({ job_id: "j1" }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const IMAGE_ITEM = { id: "p9", type: "action", label: "白边贴纸", prompt: "把这张图做成白边贴纸 {{KEY}}", kind: "image", appliesTo: ["image"] };
const TEXT_ITEM = { id: "p8", type: "action", label: "更简洁", prompt: "把 {{LINE}} 改简洁", appliesTo: ["text"] };

describe("prompt-menu image fast path (no LLM)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("itemId(kind=image) + image anchor → edit_photo fires directly, zero Claude calls", async () => {
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: OLD } });
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    const calls = stubFetch(args.env);
    const res = await runEditTurn(args);
    expect(res.ok).toBe(true);
    expect(res.reply).toContain("约 1 分钟完成");
    // paint job got the instruction verbatim as the prompt
    expect(calls.paint.body.prompt).toBe("把这张图做成白边贴纸");
    expect(calls.paint.body.callback_meta.oldKey).toBe(OLD);
    // returned article already carries the swapped marker (占位图指针)
    const body = res.article.articles[0].body;
    expect(body).not.toContain(`[[photo:${OLD}]]`);
    expect(body).toMatch(/\[\[photo:photos\/171\/\d+-[a-z0-9]+\.jpg\]\]/);
    expect(res.toolRuns).toHaveLength(1);
    expect(res.toolRuns[0]).toMatchObject({ name: "edit_photo", ok: true, fast: true });
  });

  it("falls back to the LLM when the item is not image-kind", async () => {
    const args = await makeArgs({ itemId: "p8", anchor: { type: "image", key: OLD } });
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM, TEXT_ITEM] }));
    stubFetch(args.env);
    await expect(runEditTurn(args)).rejects.toThrow(/LLM must not be called/);
  });

  it("falls back when the anchor key is not in this article", async () => {
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: "photos/nope/x.jpg" } });
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    stubFetch(args.env);
    await expect(runEditTurn(args)).rejects.toThrow(/LLM must not be called/);
  });

  it("falls back when the instruction still has unresolved placeholders", async () => {
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: OLD }, instruction: "做成贴纸 {{KEY}}" });
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    stubFetch(args.env);
    await expect(runEditTurn(args)).rejects.toThrow(/LLM must not be called/);
  });

  it("falls back when the paint service rejects (tool error → LLM path)", async () => {
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: OLD } });
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    const fn = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/files/api/articles/")) { await args.env.FILES.put(ARTICLE_KEY, init.body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      if (u.includes("/api/jobs")) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fn);
    await expect(runEditTurn(args)).rejects.toThrow(/LLM must not be called/);
  });
});

describe("loop short-circuits async photo tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("voice path: edit_photo succeeds → one Claude call, reply falls back to the tool's 出图 message", async () => {
    const args = await makeArgs({ anchor: null, itemId: null, instruction: "把图1改成贴纸" });
    const calls = stubFetch(args.env);
    let claudeCalls = 0;
    args.callClaude = async () => {
      claudeCalls++;
      return { content: [{ type: "tool_use", id: "t1", name: "edit_photo", input: { key: OLD, prompt: "贴纸" } }] };
    };
    const res = await runEditTurn(args);
    expect(claudeCalls).toBe(1); // 短路：不再为一句确认多跑一轮
    expect(res.ok).toBe(true);
    expect(res.reply).toContain("约 1 分钟完成"); // photoMsg 兜底，不是笼统的「改好了」
    expect(calls.paint.body.prompt).toBe("贴纸");
  });
});

describe("verify gating (fix 3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const verdict = (ok, issue = "") => ({ content: [{ type: "text", text: JSON.stringify({ ok, issue }) }] });

  async function runWith({ ops, anchor = null }) {
    const args = await makeArgs({ anchor, itemId: null, instruction: "改一下" });
    stubFetch(args.env);
    let claudeCalls = 0, verifies = 0;
    args.callClaude = async () => {
      claudeCalls++;
      return { content: [{ type: "tool_use", id: "t1", name: "edit_current_article", input: { ops } }] };
    };
    args.callVerify = async () => { verifies++; return verdict(true); };
    const res = await runEditTurn(args);
    return { res, verifies, claudeCalls };
  }

  it("single-op edit without anchor → haiku verifier skipped", async () => {
    const { res, verifies } = await runWith({ ops: [{ op: "replace_line", line: 1, text: "改后的第一段。" }] });
    expect(res.ok).toBe(true);
    expect(verifies).toBe(0);
  });

  it("multi-op edit → verifier runs", async () => {
    const { res, verifies } = await runWith({ ops: [
      { op: "replace_line", line: 1, text: "改后的第一段。" },
      { op: "replace_line", line: 3, text: "改后的第二段。" },
    ] });
    expect(res.ok).toBe(true);
    expect(verifies).toBe(1);
  });

  it("single-op edit WITH anchor → verifier runs", async () => {
    const { res, verifies } = await runWith({
      ops: [{ op: "replace_line", line: 1, text: "改后的第一段。" }],
      anchor: { type: "line", line: 1, text: "第一段。" },
    });
    expect(res.ok).toBe(true);
    expect(verifies).toBe(1);
  });
});

// ── 图片锚点漂移自愈（2026-07-25）──────────────────────────────────────────
import { healPhotoAnchorKey } from "../src/edit-turn.js";

describe("healPhotoAnchorKey", () => {
  it("key 还在 → 原样返回", () => {
    expect(healPhotoAnchorKey("photos/s/12-abc.jpg", ["photos/s/12-abc.jpg"])).toBe("photos/s/12-abc.jpg");
  });
  it("AI 改图换了随机尾 → 按「目录/偏移-」base 唯一匹配自愈", () => {
    expect(healPhotoAnchorKey("photos/1783430505858/1783430505858-941owf.jpg",
      ["photos/1783430505858/1783430505858-7yvucu.jpg", "photos/x/1-aa.jpg"]))
      .toBe("photos/1783430505858/1783430505858-7yvucu.jpg");
  });
  it("偏移相近不误配：12- 不匹配 120-", () => {
    expect(healPhotoAnchorKey("photos/s/12-abc.jpg", ["photos/s/120-def.jpg"])).toBeNull();
  });
  it("多个同源候选 → 丢弃（宁缺勿错）", () => {
    expect(healPhotoAnchorKey("photos/s/12-abc.jpg", ["photos/s/12-x1.jpg", "photos/s/12-x2.jpg"])).toBeNull();
  });
  it("图被删了（无同源）→ null", () => {
    expect(healPhotoAnchorKey("photos/s/12-abc.jpg", ["photos/t/9-zz.jpg"])).toBeNull();
  });
  it("legacy 无随机尾的原图 → 与它的 AI 改版同源", () => {
    expect(healPhotoAnchorKey("photos/171/171.jpg", ["photos/171/171-abc.jpg"])).toBe("photos/171/171-abc.jpg");
  });
});

describe("fast path anchor drift heal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("长按的是上一代 key（已被 AI 改图换尾）→ 自愈后仍走直通", async () => {
    // 文中现存 key 是 171-zz9.jpg（同目录同偏移，仅随机尾不同）
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: OLD } });
    const CUR = "photos/171/171-zz9.jpg";
    await args.env.FILES.put(ARTICLE_KEY, JSON.stringify({
      transcript: "t", articles: [{ title: "标题", body: `第一段。\n[[photo:${CUR}]]\n第二段。` }],
    }));
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    const calls = stubFetch(args.env);
    const res = await runEditTurn(args);
    expect(res.ok).toBe(true);
    expect(calls.paint.body.callback_meta.oldKey).toBe(CUR); // 自愈到现存 key
  });
});

describe("optimistic notify (乐观回执)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fast path 校验一过就 notify「正在生成」，先于写盘和 paint 提交", async () => {
    const events = [];
    const args = await makeArgs({ itemId: "p9", anchor: { type: "image", key: OLD } });
    args.notify = (text) => events.push(`notify:${text.slice(0, 6)}`);
    await args.env.FILES.put(SCOPE + "prompts.json", JSON.stringify({ schema: 1, items: [IMAGE_ITEM] }));
    const fn = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/api/jobs")) { events.push("paint"); return { ok: true, status: 202, json: async () => ({ job_id: "j1" }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fn);
    const res = await runEditTurn(args);
    expect(res.ok).toBe(true);
    expect(events[0]).toMatch(/^notify:/);        // 回执最先发
    expect(events).toContain("paint");            // 出图随后照常提交
  });

  it("LLM 路径不发乐观回执（notify 只属于确定性直通）", async () => {
    const events = [];
    const args = await makeArgs({ anchor: null, itemId: null, instruction: "把图1改成贴纸" });
    args.notify = (t) => events.push(t);
    stubFetch(args.env);
    args.callClaude = async () => ({ content: [{ type: "tool_use", id: "t1", name: "edit_photo", input: { key: OLD, prompt: "贴纸" } }] });
    const res = await runEditTurn(args);
    expect(res.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

// ── 直写不泄漏顶层字段（undo 场景的权威性，2026-07-25 自查发现）────────────────
import { runTool } from "../src/tools.js";
import { withTopLevelArticles, setHead } from "../../functions/lib/article-store.js";

describe("direct write keeps schema-3 clean", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("编辑后存量 doc 无顶层 articles/history；undo 后 withTopLevelArticles 跟随 head", async () => {
    const args = await makeArgs({});
    stubFetch(args.env);
    const ctx = { env: args.env, scope: SCOPE, articleKey: ARTICLE_KEY, token: "t", origin: "https://vd.test" };
    // 种子是 schema-2（无 versions）：第一次直写必须先迁移再追加，不能重置成 v1
    await runTool("edit_current_article", { ops: [{ op: "replace_line", line: 1, text: "V2版第一段。" }] }, ctx);
    await runTool("edit_current_article", { ops: [{ op: "replace_line", line: 1, text: "V3版第一段。" }] }, ctx);
    const stored = JSON.parse(await (await args.env.FILES.get(ARTICLE_KEY)).text());
    expect("articles" in stored).toBe(false);   // 顶层正文不落盘（只活在 versions[head]）
    expect("history" in stored).toBe(false);
    expect(stored.versions.map((v) => v.v)).toEqual([1, 2, 3]); // 原文=v1，两次编辑=v2/v3
    // undo 回 v2 → 快照/raw download 用的 withTopLevelArticles 必须给 v2 内容
    await setHead(args.env, ARTICLE_KEY, 2);
    const after = JSON.parse(await (await args.env.FILES.get(ARTICLE_KEY)).text());
    expect(withTopLevelArticles(after).articles[0].body).toContain("V2版");
  });
});
