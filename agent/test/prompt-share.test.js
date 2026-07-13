// test/prompt-share.test.js — 指令分享码（魔法数字）：铸码 / 发布与撤销路由 /
// 兑换识别与注入块 / 保存写穿。spec：voicedrop repo
// docs/superpowers/specs/2026-07-11-prompt-share-magic-number-design.md
import { vi, describe, it, expect } from "vitest";
// vi.mock is hoisted before static imports — keeps the real `agents` package
// (and its cloudflare:workers import) out of the Node/vitest module graph.
// Same pattern as paint-callback-route.test.js / ui-config.test.js / mine-sharding.test.js.
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv } from "./fakes.js";
import { hmacSign, b64url } from "../../functions/lib/auth.js";
import {
  PROMPT_SHARE_DEFAULTS, loadPromptShareConfig, mintCode,
  handlePromptShareRoutes, resolvePromptShare, resolveSharedPromptBlock, refreshPromptShare,
} from "../src/prompt-share.js";
import { handleUIConfigCustom } from "../src/ui-config-custom.js";
import worker from "../src/index.js";

const SECRET = "test-secret";
async function makeToken(scope) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, apple: true }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

const OWNER = "users/anon-owner111/";
// 内置叶子「改写这段 · 更简洁」，默认指令含 {{LINE}}/{{QUOTE}} 占位符。
const ITEM = "voice-editor.longpress.text.rewrite.concise";

function makeEnv(seed = {}) {
  const e = fakeEnv(seed);
  e.SESSION_SECRET = SECRET;
  return e;
}

async function post(e, body, scope = OWNER) {
  const req = new Request("https://jianshuo.dev/agent/prompt-share", {
    method: "POST",
    headers: scope ? { Authorization: `Bearer ${await makeToken(scope)}` } : {},
    body: JSON.stringify(body),
  });
  return handlePromptShareRoutes(new URL(req.url), req, e);
}

async function del(e, itemId, scope = OWNER) {
  const req = new Request(`https://jianshuo.dev/agent/prompt-share/${encodeURIComponent(itemId)}`, {
    method: "DELETE",
    headers: scope ? { Authorization: `Bearer ${await makeToken(scope)}` } : {},
  });
  return handlePromptShareRoutes(new URL(req.url), req, e);
}

// 直接 seed 一份写穿后的 shares/<code> 文档（兑换/落地读的就是它）。
const sharedDoc = (over = {}) => JSON.stringify({
  type: "prompt", sub: "anon-owner111", itemId: ITEM,
  label: "更毒舌", instruction: "把它改得更毒舌，观点不变。",
  createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z", ...over,
});

describe("loadPromptShareConfig", () => {
  it("defaults when no R2 file / bad JSON", async () => {
    expect(await loadPromptShareConfig(makeEnv())).toEqual(PROMPT_SHARE_DEFAULTS);
    expect(await loadPromptShareConfig(makeEnv({ "config/prompt-share.json": "{broken" }))).toEqual(PROMPT_SHARE_DEFAULTS);
  });
  it("R2 override merges over defaults", async () => {
    const cfg = await loadPromptShareConfig(makeEnv({ "config/prompt-share.json": JSON.stringify({ dailyCapPerUser: 2 }) }));
    expect(cfg.dailyCapPerUser).toBe(2);
    expect(cfg.enabled).toBe(true);
  });
});

describe("mintCode", () => {
  it("returns a 7-digit code, first digit non-zero", async () => {
    const code = await mintCode(makeEnv());
    expect(code).toMatch(/^[1-9][0-9]{6}$/);
  });
  it("re-rolls on collision with an existing shares/<code>", async () => {
    const e = makeEnv({ "shares/1234567": sharedDoc() });
    const seq = ["1234567", "7654321"];
    const code = await mintCode(e, () => seq.shift());
    expect(code).toBe("7654321");
  });
  it("gives up (null) after 5 collisions", async () => {
    const e = makeEnv({ "shares/1234567": sharedDoc() });
    expect(await mintCode(e, () => "1234567")).toBe(null);
  });
});

describe("POST /agent/prompt-share", () => {
  it("401 without token", async () => {
    const r = await post(makeEnv(), { id: ITEM }, null);
    expect(r.status).toBe(401);
  });
  it("400 without id", async () => {
    const r = await post(makeEnv(), {});
    expect(r.status).toBe(400);
  });
  it("404 unknown id", async () => {
    const r = await post(makeEnv(), { id: "voice-editor.longpress.text.rewrite.nope" });
    expect(r.status).toBe(404);
  });
  it("503 when disabled by config", async () => {
    const e = makeEnv({ "config/prompt-share.json": JSON.stringify({ enabled: false }) });
    expect((await post(e, { id: ITEM })).status).toBe(503);
  });
  it("413 when effective text exceeds maxLength", async () => {
    const e = makeEnv({
      "config/prompt-share.json": JSON.stringify({ maxLength: 10 }),
      [`${OWNER}ui-config.json`]: JSON.stringify({ overrides: { [ITEM]: { instruction: "这一条自定义指令远远超过十个字符的上限了" } }, hidden: [] }),
    });
    expect((await post(e, { id: ITEM })).status).toBe(413);
  });
  it("200 mints: shares/<code> carries the DEFAULT effective text when no override", async () => {
    const e = makeEnv();
    const r = await post(e, { id: ITEM });
    expect(r.status).toBe(200);
    const { code, url, created, sharing } = await r.json();
    expect(code).toMatch(/^[1-9][0-9]{6}$/);
    expect(url).toBe(`https://voicedrop.cn/${code}`);
    expect(created).toBe(true);
    expect(sharing).toBe(true);
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.type).toBe("prompt");
    expect(doc.sub).toBe("anon-owner111");
    expect(doc.itemId).toBe(ITEM);
    expect(doc.label).toBe("更简洁");                       // 默认名 = 层级 label 最后一段
    expect(doc.instruction).toContain("{{LINE}}");           // 内置默认指令
    const idx = JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`));
    expect(idx.byItem[ITEM].code).toBe(code);
    expect(idx.mintLog).toHaveLength(1);
  });
  it("200 mints with the user's override text + custom label", async () => {
    const e = makeEnv({
      [`${OWNER}ui-config.json`]: JSON.stringify({ overrides: { [ITEM]: { instruction: "改得更毒舌。", label: "更毒舌" } }, hidden: [] }),
    });
    const r = await post(e, { id: ITEM });
    const { code } = await r.json();
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.label).toBe("更毒舌");
    expect(doc.instruction).toBe("改得更毒舌。");
  });
  it("re-POST same id is idempotent: same code, created:false, mintLog unchanged", async () => {
    const e = makeEnv();
    const first = await (await post(e, { id: ITEM })).json();
    const again = await (await post(e, { id: ITEM })).json();
    expect(again.code).toBe(first.code);
    expect(again.created).toBe(false);
    expect(JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`)).mintLog).toHaveLength(1);
  });
  it("DELETE then POST revives the SAME code", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    await del(e, ITEM);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
    const revived = await (await post(e, { id: ITEM })).json();
    expect(revived.code).toBe(code);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(true);
  });
  it("429 past the daily cap (config-tunable), idempotent re-POST does not consume", async () => {
    const e = makeEnv({ "config/prompt-share.json": JSON.stringify({ dailyCapPerUser: 2 }) });
    expect((await post(e, { id: "voice-editor.longpress.text.rewrite.concise" })).status).toBe(200);
    expect((await post(e, { id: "voice-editor.longpress.text.rewrite.casual" })).status).toBe(200);
    // 幂等重复不占额度
    expect((await post(e, { id: "voice-editor.longpress.text.rewrite.concise" })).status).toBe(200);
    expect((await post(e, { id: "voice-editor.longpress.text.rewrite.formal" })).status).toBe(429);
  });
});

describe("DELETE /agent/prompt-share/<itemId>", () => {
  it("401 without token", async () => {
    expect((await del(makeEnv(), ITEM, null)).status).toBe(401);
  });
  it("removes shares/<code> but keeps the owner index", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    const r = await del(e, ITEM);
    expect(r.status).toBe(200);
    expect((await r.json()).sharing).toBe(false);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
    expect(JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`)).byItem[ITEM].code).toBe(code);
  });
  it("is idempotent for a never-shared item", async () => {
    const r = await del(makeEnv(), ITEM);
    expect(r.status).toBe(200);
  });
});

describe("resolvePromptShare", () => {
  it("reads the denormalized doc", async () => {
    const e = makeEnv({ "shares/4563566": sharedDoc() });
    const hit = await resolvePromptShare(e, "4563566");
    expect(hit.label).toBe("更毒舌");
    expect(hit.instruction).toContain("毒舌");
  });
  it("null when missing / not a prompt entry (legacy article key)", async () => {
    const e = makeEnv({ "shares/aB3xK9pQr2": "users/u/articles/s.json" });
    expect(await resolvePromptShare(e, "9999999")).toBe(null);
    expect(await resolvePromptShare(e, "aB3xK9pQr2")).toBe(null);
  });
});

describe("resolveSharedPromptBlock", () => {
  const seeded = () => makeEnv({ "shares/4563566": sharedDoc(), "shares/7654321": sharedDoc({ label: "另一条", instruction: "另一条指令。" }) });

  it("hits a plain 7-digit code; block carries delimiters + label + text, no placeholder note", async () => {
    const block = await resolveSharedPromptBlock(seeded(), "用4563566改这段");
    expect(block).toContain("【分享提示词开始】");
    expect(block).toContain("【分享提示词结束】");
    expect(block).toContain("更毒舌");
    expect(block).toContain("把它改得更毒舌");
    expect(block).not.toContain("占位符");
    expect(block).toContain("一次性");
  });
  it("adds the placeholder note only when the instruction contains {{", async () => {
    const e = makeEnv({ "shares/4563566": sharedDoc({ instruction: "把第{{LINE}}行改好。" }) });
    const block = await resolveSharedPromptBlock(e, "用4563566");
    expect(block).toContain("占位符");
  });
  it("normalizes ASR pauses: spaces / hyphens / 中文逗号 between digits", async () => {
    expect(await resolveSharedPromptBlock(seeded(), "用 456 3566 处理")).toContain("更毒舌");
    expect(await resolveSharedPromptBlock(seeded(), "用456-3566处理")).toContain("更毒舌");
    expect(await resolveSharedPromptBlock(seeded(), "用456，3566处理")).toContain("更毒舌");
  });
  it("ignores 8+ digit runs and leading-zero runs", async () => {
    expect(await resolveSharedPromptBlock(seeded(), "打电话13800138000")).toBe(null);
    expect(await resolveSharedPromptBlock(seeded(), "编号0123456")).toBe(null);
  });
  it("null when no digits at all", async () => {
    expect(await resolveSharedPromptBlock(seeded(), "把这段改得简洁点")).toBe(null);
  });
  it("first code wins when two are present", async () => {
    const block = await resolveSharedPromptBlock(seeded(), "先用4563566再用7654321");
    expect(block).toContain("更毒舌");
    expect(block).not.toContain("另一条");
  });
  it("valid-format but unknown code → soft not-found note; config can silence it", async () => {
    const note = await resolveSharedPromptBlock(makeEnv(), "用9999999改");
    expect(note).toContain("9999999");
    expect(note).toContain("无效");
    const silent = makeEnv({ "config/prompt-share.json": JSON.stringify({ notFoundNote: false }) });
    expect(await resolveSharedPromptBlock(silent, "用9999999改")).toBe(null);
  });
});

describe("write-through on save (refreshPromptShare + ui-config-custom PUT)", () => {
  it("refreshPromptShare rewrites an ACTIVE share with the current effective text", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    // 作者改了自定义文本（直接写覆盖文件模拟）
    e.FILES._store.set(`${OWNER}ui-config.json`, JSON.stringify({ overrides: { [ITEM]: { instruction: "新版毒舌。", label: "更毒舌" } }, hidden: [] }));
    await refreshPromptShare(e, OWNER, ITEM);
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.instruction).toBe("新版毒舌。");
    expect(doc.label).toBe("更毒舌");
  });
  it("does NOT resurrect a toggled-off share", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    await del(e, ITEM);
    await refreshPromptShare(e, OWNER, ITEM);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
  });
  it("PUT /agent/ui-config/custom writes through to the shared doc", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    const put = new Request("https://jianshuo.dev/agent/ui-config/custom", {
      method: "PUT", body: JSON.stringify({ id: ITEM, instruction: "保存即同步。", label: "同步版" }),
    });
    await handleUIConfigCustom(put, e, OWNER);
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.instruction).toBe("保存即同步。");
    expect(doc.label).toBe("同步版");
  });
});

describe("GET /agent/ui-config/custom carries sharing state", () => {
  it("shareCode + sharing reflect mint / toggle-off", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: ITEM })).json();
    const get = () => handleUIConfigCustom(new Request("https://jianshuo.dev/agent/ui-config/custom"), e, OWNER);
    let items = (await (await get()).json()).items;
    let item = items.find((i) => i.id === ITEM);
    expect(item.shareCode).toBe(code);
    expect(item.sharing).toBe(true);
    // 其他条目无码
    expect(items.find((i) => i.id !== ITEM).shareCode).toBe(null);

    await del(e, ITEM);
    items = (await (await get()).json()).items;
    item = items.find((i) => i.id === ITEM);
    expect(item.shareCode).toBe(code);   // 码还在（再开同码）
    expect(item.sharing).toBe(false);
  });
});

// author 走共用的 functions/lib/style-store.js#readProfileName——但预览端点显式传
// { fallback: "none" }，与 miner/mint/社区帖那条「无名兜底 ID 前 6 位大写」的默认
// 路径分道：那条 ID 短标签是稳定身份约定（同一用户账单/社区帖前后一致的代号），
// 搬到这条公开导入预览里就成了「来自 ABC」这种没有信息量的乱码，且客户端无法
// 区分它是真名还是兜底——spec §8 明说「读不到名字 → 不显示『来自』行」，也就是
// author 必须是空串，交给 iOS 客户端据此隐藏整行。miner/mint 的默认行为不受影响，
// 见 style-store.test.js 里 readProfileName 的独立单测。
describe("GET /agent/prompt-share/<code> — 4b 导入预览（公开，无需 token）", () => {
  const shareDoc = (over = {}) => JSON.stringify({
    type: "prompt", sub: "anon-abc", itemId: "p_zq1f6e",
    label: "改写成播客口播稿", instruction: "把文章改写成适合朗读的口播稿…",
    appliesTo: ["text"], importCount: 128,
    createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  });
  const GETC = (env, code) => worker.fetch(new Request(`https://jianshuo.dev/agent/prompt-share/${code}`), env);

  it("有效码 → 200 + 预览负载（无需 Authorization）", async () => {
    const env = fakeEnv({
      "shares/4820135": shareDoc(),
      "users/anon-abc/CLAUDE.md": "# 我的名字\n老周\n\n# 我的文风\n随性",
    });
    const res = await GETC(env, "4820135");
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.label).toBe("改写成播客口播稿");
    expect(b.prompt).toContain("口播稿");
    expect(b.appliesTo).toEqual(["text"]);
    expect(b.importCount).toBe(128);
    expect(b.author).toBe("老周");
  });

  it("★ 老副本没有 appliesTo → 回退都行；没有 importCount → 0", async () => {
    const env = fakeEnv({ "shares/4820135": shareDoc({ appliesTo: undefined, importCount: undefined }) });
    const b = await (await GETC(env, "4820135")).json();
    expect(new Set(b.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(b.importCount).toBe(0);
  });

  it("没设置名字 → author 为空串（spec §8：读不到名字 → 不显示「来自」行）", async () => {
    const env = fakeEnv({ "shares/4820135": shareDoc() }); // 没有 CLAUDE.md/CLAUDE.json
    const b = await (await GETC(env, "4820135")).json();
    expect(b.author).toBe(""); // 不是 ID 前 6 位大写兜底——那是 miner/mint 的默认约定，这里显式关闭
  });

  it("设置了真名 → author 原样透出（fallback:'none' 不影响真实姓名命中）", async () => {
    const env = fakeEnv({
      "shares/4820135": shareDoc(),
      "users/anon-abc/CLAUDE.json": JSON.stringify({ schema: 3, head: 1, versions: [{ v: 1, savedAt: 1, source: "app", style: "x" }], createdAt: 1, updatedAt: 1, profile: { name: "老周" } }),
    });
    const b = await (await GETC(env, "4820135")).json();
    expect(b.author).toBe("老周");
  });

  it("readProfileName 读取异常不影响预览：捕获后 author 兜底空串", async () => {
    const env = fakeEnv({ "shares/4820135": shareDoc() });
    const origGet = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (key) => {
      if (key.startsWith("users/anon-abc/")) throw new Error("boom"); // 模拟 profile 读取抖动
      return origGet(key);
    };
    const res = await GETC(env, "4820135");
    expect(res.status).toBe(200); // profile 读取失败不能连累整个预览 404
    expect((await res.json()).author).toBe("");
  });

  it("查无此码 → 404", async () => {
    expect((await GETC(fakeEnv(), "9999999")).status).toBe(404);
  });

  it("码指向的是文章分享（纯字符串值），不是提示词 → 404", async () => {
    const env = fakeEnv({ "shares/4820135": "users/anon-x/articles/foo.json" });
    expect((await GETC(env, "4820135")).status).toBe(404);
  });

  it("码指向 JSON 但 type:prompt 且缺 instruction → 404（不是半成品预览）", async () => {
    const env = fakeEnv({ "shares/4820135": JSON.stringify({ type: "prompt", sub: "anon-abc", itemId: "x", label: "坏文档" }) });
    expect((await GETC(env, "4820135")).status).toBe(404);
  });

  it("sub 带路径字符（../）不逃逸到别的 scope 前缀之外", async () => {
    const evil = JSON.stringify({
      type: "prompt", sub: "../../etc", itemId: "p1", label: "坏", instruction: "坏指令",
      createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    });
    const env = fakeEnv({ "shares/4820135": evil });
    const res = await GETC(env, "4820135");
    expect(res.status).toBe(200); // 预览本身仍应正常返回（不因奇怪的 sub 而 500/404）
    const b = await res.json();
    // R2 key 是扁平字符串，"../" 不构成真实目录穿越；拼出的 scope 在 fakeEnv 里查无
    // 任何 profile 文件，兜底走 ID 前 6 位，不抛异常、不 404、不读到别的用户的名字。
    expect(typeof b.author).toBe("string");
    expect(b.author).not.toMatch(/老周|老周文风/);
  });

  it("码格式非法 → 404", async () => {
    expect((await GETC(fakeEnv(), "abc")).status).toBe(404);
    expect((await GETC(fakeEnv(), "0123456")).status).toBe(404);   // 首位 0
    expect((await GETC(fakeEnv(), "48201356")).status).toBe(404); // 8 位
  });

  it("POST/DELETE 分支不被 GET 分流误伤：GET 不需要 Authorization 也不会撞进 401", async () => {
    const env = fakeEnv({ "shares/4820135": shareDoc() });
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-share/4820135", { method: "GET" }), env);
    expect(res.status).toBe(200);
  });
});
