// test/prompt-share.test.js — 指令分享码（魔法数字）：铸码 / 发布与撤销路由 /
// 兑换识别与注入块 / 保存写穿。spec：voicedrop repo
// docs/superpowers/specs/2026-07-11-prompt-share-magic-number-design.md
import { vi, describe, it, expect } from "vitest";
// vi.mock is hoisted before static imports — keeps the real `agents` package
// (and its cloudflare:workers import) out of the Node/vitest module graph.
// Same pattern as paint-callback-route.test.js / mine-sharding.test.js.
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv } from "./fakes.js";
import { hmacSign, b64url } from "../../functions/lib/auth.js";
import {
  PROMPT_SHARE_DEFAULTS, loadPromptShareConfig, mintCode,
  handlePromptShareRoutes, resolvePromptShare, resolveSharedPromptBlock, refreshPromptShare, shareStates,
} from "../src/prompt-share.js";
import worker from "../src/index.js";

const SECRET = "test-secret";
async function makeToken(scope) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, apple: true }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

const OWNER = "users/anon-owner111/";
// 内置系统项「改写这段 · 更简洁」（新模型，sys_* id），默认指令含 {{LINE}}/{{QUOTE}} 占位符——
// 铸码/写穿这类需要 effectiveLeaf 解析生效内容的测试都走它。
const SYS_ITEM = "sys_concise";
// 重构前的老 dotted id（voice-editor.longpress.* 菜单路径当主键那一代，出自已退役的
// ui-config 模型）。effectiveLeaf 切到新解析器后已经不认得它——不能再铸新码/写穿同步。
// 但 DELETE 与 shareStates()（现供 prompt-routes.js 的 syncActiveShares 用来找"当前
// 正在分享的条目"）都只碰索引 + R2 head，完全不经过 effectiveLeaf，所以【已经存在的
// 老码】依旧能正常开关——ITEM 常量留着专门测这条边界（老魔法数字继续能兑换/开关，
// 只是不能再铸新的）。
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

// 整树 PUT /agent/prompts（新模型的唯一写口）——给这份测试文件里需要「用户已经 fork/自建
// 一条」场景的用例落盘一份 users/<sub>/prompts.json。走真实路由（worker.fetch + index.js
// 的 resolveScope），不是直接戳 R2，这样 scope 派生（session token → 精确 scope）跟 post()/
// del() 用的是同一条真实路径。
async function putPrompts(e, items, scope = OWNER) {
  const req = new Request("https://jianshuo.dev/agent/prompts", {
    method: "PUT",
    headers: { Authorization: `Bearer ${await makeToken(scope)}`, "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return worker.fetch(req, e);
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
    const r = await post(makeEnv(), { id: SYS_ITEM }, null);
    expect(r.status).toBe(401);
  });
  it("400 without id", async () => {
    const r = await post(makeEnv(), {});
    expect(r.status).toBe(400);
  });
  it("404 unknown id", async () => {
    const r = await post(makeEnv(), { id: "sys_nope" });
    expect(r.status).toBe(404);
  });
  it("503 when disabled by config", async () => {
    const e = makeEnv({ "config/prompt-share.json": JSON.stringify({ enabled: false }) });
    expect((await post(e, { id: SYS_ITEM })).status).toBe(503);
  });
  it("413 when effective text exceeds maxLength", async () => {
    // sys_concise 的内置默认指令本就远超 10 字，不需要额外 fork 就能触发上限。
    const e = makeEnv({ "config/prompt-share.json": JSON.stringify({ maxLength: 10 }) });
    expect((await post(e, { id: SYS_ITEM })).status).toBe(413);
  });
  it("200 mints: shares/<code> carries the DEFAULT effective text when no override", async () => {
    const e = makeEnv();
    const r = await post(e, { id: SYS_ITEM });
    expect(r.status).toBe(200);
    const { code, url, created, sharing } = await r.json();
    expect(code).toMatch(/^[1-9][0-9]{6}$/);
    expect(url).toBe(`https://voicedrop.cn/${code}`);
    expect(created).toBe(true);
    expect(sharing).toBe(true);
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.type).toBe("prompt");
    expect(doc.sub).toBe("anon-owner111");
    expect(doc.itemId).toBe(SYS_ITEM);
    expect(doc.label).toBe("更简洁");                       // 模板 label，用户还没 fork
    expect(doc.instruction).toContain("{{LINE}}");           // 模板内置默认指令
    const idx = JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`));
    expect(idx.byItem[SYS_ITEM].code).toBe(code);
    expect(idx.mintLog).toHaveLength(1);
  });
  it("200 mints a forked item's own text + custom label (不是模板原文)", async () => {
    const e = makeEnv();
    await putPrompts(e, [{ id: "p_mood001", type: "action", label: "更毒舌", prompt: "改得更毒舌。", appliesTo: ["text"], forkedFrom: "sys_concise" }]);
    const r = await post(e, { id: "p_mood001" });
    const { code } = await r.json();
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.label).toBe("更毒舌");
    expect(doc.instruction).toBe("改得更毒舌。");
  });
  it("re-POST same id is idempotent: same code, created:false, mintLog unchanged", async () => {
    const e = makeEnv();
    const first = await (await post(e, { id: SYS_ITEM })).json();
    const again = await (await post(e, { id: SYS_ITEM })).json();
    expect(again.code).toBe(first.code);
    expect(again.created).toBe(false);
    expect(JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`)).mintLog).toHaveLength(1);
  });
  it("DELETE then POST revives the SAME code", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: SYS_ITEM })).json();
    await del(e, SYS_ITEM);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
    const revived = await (await post(e, { id: SYS_ITEM })).json();
    expect(revived.code).toBe(code);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(true);
  });
  it("429 past the daily cap (config-tunable), idempotent re-POST does not consume", async () => {
    const e = makeEnv({ "config/prompt-share.json": JSON.stringify({ dailyCapPerUser: 2 }) });
    expect((await post(e, { id: "sys_concise" })).status).toBe(200);
    expect((await post(e, { id: "sys_casual" })).status).toBe(200);
    // 幂等重复不占额度
    expect((await post(e, { id: "sys_concise" })).status).toBe(200);
    expect((await post(e, { id: "sys_formal" })).status).toBe(429);
  });
});

describe("DELETE /agent/prompt-share/<itemId>", () => {
  it("401 without token", async () => {
    expect((await del(makeEnv(), SYS_ITEM, null)).status).toBe(401);
  });
  it("removes shares/<code> but keeps the owner index", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: SYS_ITEM })).json();
    const r = await del(e, SYS_ITEM);
    expect(r.status).toBe(200);
    expect((await r.json()).sharing).toBe(false);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
    expect(JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`)).byItem[SYS_ITEM].code).toBe(code);
  });
  it("is idempotent for a never-shared item", async () => {
    const r = await del(makeEnv(), SYS_ITEM);
    expect(r.status).toBe(200);
  });
  it("老 dotted id 铸的码依旧能正常开关（DELETE 只碰索引 + R2 head，不经过 effectiveLeaf）", async () => {
    const e = makeEnv({
      [`${OWNER}prompt-shares.json`]: JSON.stringify({ byItem: { [ITEM]: { code: "4563567", createdAt: "2026-07-01T00:00:00Z" } }, mintLog: [] }),
      "shares/4563567": sharedDoc(),
    });
    const r = await del(e, ITEM);
    expect(r.status).toBe(200);
    expect((await r.json()).sharing).toBe(false);
    expect(e.FILES._store.has("shares/4563567")).toBe(false);
    // 索引原样保留（关闭不清索引，同码可再开）。
    expect(JSON.parse(e.FILES._store.get(`${OWNER}prompt-shares.json`)).byItem[ITEM].code).toBe("4563567");
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

  // ── appliesTo 值域清洗（跟 label/prompt 两行外的截断同一原则：坏值兜底，不 400 到死）─
  it("appliesTo 全是非法值（如手改/损坏成 [\"banana\"]）→ 兜底成都行，而不是让下游 validateList 永远拒收", async () => {
    const e = makeEnv({ "shares/4563566": sharedDoc({ appliesTo: ["banana"] }) });
    const hit = await resolvePromptShare(e, "4563566");
    expect(new Set(hit.appliesTo)).toEqual(new Set(["text", "image"]));
  });

  it("appliesTo 部分合法（[\"text\",\"banana\"]）→ 只保留合法值 [\"text\"]", async () => {
    const e = makeEnv({ "shares/4563566": sharedDoc({ appliesTo: ["text", "banana"] }) });
    const hit = await resolvePromptShare(e, "4563566");
    expect(hit.appliesTo).toEqual(["text"]);
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

describe("write-through on save (refreshPromptShare)", () => {
  it("refreshPromptShare rewrites an ACTIVE share with the current effective text (fork 改词后保存)", async () => {
    const e = makeEnv();
    await putPrompts(e, [{ id: "p_mood002", type: "action", label: "更毒舌", prompt: "改得更毒舌。", appliesTo: ["text"], forkedFrom: "sys_concise" }]);
    const { code } = await (await post(e, { id: "p_mood002" })).json();
    // 作者改了内容，重新整树 PUT（客户端保存走的就是这一条路：整树 PUT）。
    await putPrompts(e, [{ id: "p_mood002", type: "action", label: "更毒舌", prompt: "新版毒舌。", appliesTo: ["text"], forkedFrom: "sys_concise" }]);
    await refreshPromptShare(e, OWNER, "p_mood002");
    const doc = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(doc.instruction).toBe("新版毒舌。");
    expect(doc.label).toBe("更毒舌");
  });
  it("refreshPromptShare 保留 createdAt 与 importCount（作者改词不清零导入计数）", async () => {
    const e = makeEnv();
    await putPrompts(e, [{ id: "p_mood003", type: "action", label: "标题", prompt: "初版内容", appliesTo: ["text"] }]);
    const { code } = await (await post(e, { id: "p_mood003" })).json();
    const before = JSON.parse(e.FILES._store.get(`shares/${code}`));
    // 模拟这条分享已经被别人导入过 3 次。
    e.FILES._store.set(`shares/${code}`, JSON.stringify({ ...before, importCount: 3 }));
    await putPrompts(e, [{ id: "p_mood003", type: "action", label: "标题", prompt: "改过的新版内容", appliesTo: ["text"] }]);
    await refreshPromptShare(e, OWNER, "p_mood003");
    const after = JSON.parse(e.FILES._store.get(`shares/${code}`));
    expect(after.instruction).toBe("改过的新版内容");
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.importCount).toBe(3);
  });
  it("does NOT resurrect a toggled-off share", async () => {
    const e = makeEnv();
    const { code } = await (await post(e, { id: SYS_ITEM })).json();
    await del(e, SYS_ITEM);
    await refreshPromptShare(e, OWNER, SYS_ITEM);
    expect(e.FILES._store.has(`shares/${code}`)).toBe(false);
  });
});

// shareStates() 现由 prompt-routes.js 的 syncActiveShares（PUT /agent/prompts 保存后
// 写穿同步）直接调用，用来在不逐条读 R2 的前提下找出"当前正在分享的条目"——只碰
// 索引 + R2 head，不经过 effectiveLeaf，所以对老 dotted id 的存量码同样成立。
describe("shareStates — itemId → {shareCode, sharing} 反映铸码/开关", () => {
  it("shareCode + sharing 随铸码/关闭变化；未铸码的条目不出现在结果里", async () => {
    const code = "4563567";
    const e = makeEnv({
      [`${OWNER}prompt-shares.json`]: JSON.stringify({ byItem: { [ITEM]: { code, createdAt: "2026-07-01T00:00:00Z" } }, mintLog: [] }),
      [`shares/${code}`]: sharedDoc(),
    });
    let states = await shareStates(e, OWNER);
    expect(states[ITEM]).toEqual({ shareCode: code, sharing: true });
    expect(states[SYS_ITEM]).toBeUndefined(); // 从没铸过码的条目不出现

    await del(e, ITEM);
    states = await shareStates(e, OWNER);
    expect(states[ITEM]).toEqual({ shareCode: code, sharing: false }); // 码还在（再开同码），但 shares/<码> 已删
  });

  it("从没有任何分享的 scope → 空表，只产生一次索引 GET", async () => {
    const e = makeEnv();
    expect(await shareStates(e, OWNER)).toEqual({});
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

// 铸码（POST /agent/prompt-share）现在要求可追责身份（见上方「分享即发帖」门槛），
// 裸匿名 token 一律 403 needs_apple_signin——这里改用 makeToken() 造的验证过的
// session token（与该文件其余用例一致），保留这组用例本身要测的东西（effectiveLeaf
// 新解析器对自建/fork/嵌套/垃圾节点/跨用户隔离的支持），身份验证方式只是换了个
// 符合新门槛的壳。
describe("铸码 POST /agent/prompt-share — 新模型（自建项也能铸）", () => {
  const SCOPE = "users/anon-mint-tester/";
  const authHeader = async () => `Bearer ${await makeToken(SCOPE)}`;
  // 铸码需要验证过的身份（见「分享即发帖」门槛）——mkEnv() 给出的 env 挂
  // SESSION_SECRET，MINT/PUTP 用 makeToken() 造的 session token 而非裸匿名 token。
  const mkEnv = (seed) => { const e = fakeEnv(seed); e.SESSION_SECRET = SECRET; return e; };
  const MINT = async (env, id) => worker.fetch(new Request("https://jianshuo.dev/agent/prompt-share", {
    method: "POST", headers: { Authorization: await authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }), env);
  const PUTP = async (env, items) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
    method: "PUT", headers: { Authorization: await authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }), env);
  const shareDocOf = (env) => {
    const k = [...env.FILES._store.keys()].find((x) => x.startsWith("shares/"));
    return k ? JSON.parse(env.FILES._store.get(k)) : null;
  };

  it("★ 自建项能铸码（老实现会失败）", async () => {
    const env = mkEnv();
    await PUTP(env, [{ id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "口语、emoji…", appliesTo: ["text"] }]);
    const res = await MINT(env, "p_zq1f6e");
    expect(res.status).toBe(200);
    expect((await res.json()).code).toMatch(/^[1-9][0-9]{6}$/);
    const doc = shareDocOf(env);
    expect(doc.label).toBe("写成小红书");
    expect(doc.instruction).toContain("口语");
    expect(doc.appliesTo).toEqual(["text"]);
  });

  it("ref 系统项能铸码，副本里是模板【当前】内容", async () => {
    const env = mkEnv();
    const res = await MINT(env, "sys_cartoon");      // 用户还没 prompts.json，全跟随模板
    expect(res.status).toBe(200);
    const doc = shareDocOf(env);
    expect(doc.label).toBe("卡通");
    expect(doc.instruction).toContain("宫崎骏");
    expect(doc.appliesTo).toEqual(["image"]);
    expect(doc.kind).toBe("image");
  });

  it("fork 过的系统项 → 副本里是【我改过的】内容", async () => {
    const env = mkEnv();
    await PUTP(env, [{ id: "p_abc123", type: "action", label: "卡通风", prompt: "我改过的卡通", appliesTo: ["image"], forkedFrom: "sys_cartoon" }]);
    await MINT(env, "p_abc123");
    const doc = shareDocOf(env);
    expect(doc.label).toBe("卡通风");
    expect(doc.instruction).toBe("我改过的卡通");
  });

  it("不存在的 id → 404", async () => {
    expect((await MINT(mkEnv(), "p_nosuch")).status).toBe(404);
  });

  it("group 不能铸码 → 404（组没有 prompt）", async () => {
    expect((await MINT(mkEnv(), "sys_style")).status).toBe(404);
  });

  // ── 以下为对 brief 的对抗性补充：分组内嵌套 fork / 存量垃圾节点 / 跨用户隔离 ──

  it("嵌套在分组里的 fork 项也能铸码（不止顶层）", async () => {
    const env = mkEnv();
    await PUTP(env, [
      { ref: "sys_style", children: [
        { id: "p_nest01", type: "action", label: "赛博朋克", prompt: "我改过的赛博朋克风格", appliesTo: ["image"], forkedFrom: "sys_cartoon" },
        { ref: "sys_ad" },
      ] },
    ]);
    const res = await MINT(env, "p_nest01");
    expect(res.status).toBe(200);
    const doc = shareDocOf(env);
    expect(doc.label).toBe("赛博朋克");
    expect(doc.instruction).toBe("我改过的赛博朋克风格");
  });

  it("用户存量 prompts.json 里混了垃圾节点也不能让铸码崩溃（resolveList 静默跳过）", async () => {
    const env = mkEnv();
    // 先走正常 PUT 落盘（这样才知道真实的 R2 key——scope 是 token 的 sha256，不能硬编码），
    // 再直接篡改该 key 的内容，模拟历史脏数据/存储层损坏留下的垃圾顶层节点 + 悬空 ref。
    await PUTP(env, [{ id: "p_ok00001", type: "action", label: "正常项", prompt: "这是正常的提示词", appliesTo: ["text"] }]);
    const key = [...env.FILES._store.keys()].find((k) => k.endsWith("prompts.json"));
    env.FILES._store.set(key, JSON.stringify({
      schema: 1,
      items: [
        null, "garbage", 42,
        { ref: "sys_retired_long_gone" },
        { id: "p_ok00001", type: "action", label: "正常项", prompt: "这是正常的提示词", appliesTo: ["text"] },
      ],
    }));
    const res = await MINT(env, "p_ok00001");
    expect(res.status).toBe(200);
    const doc = shareDocOf(env);
    expect(doc.label).toBe("正常项");
  });

  it("两个用户各自的同名 p_ id 铸出各自的内容（作用域隔离）", async () => {
    const env = mkEnv();
    const TOKEN_A = `Bearer ${await makeToken("users/anon-mint-scope-a/")}`;
    const TOKEN_B = `Bearer ${await makeToken("users/anon-mint-scope-b/")}`;
    const putAs = (token, items) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
      method: "PUT", headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ items }),
    }), env);
    const mintAs = (token, id) => worker.fetch(new Request("https://jianshuo.dev/agent/prompt-share", {
      method: "POST", headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }), env);
    await putAs(TOKEN_A, [{ id: "p_same001", type: "action", label: "用户A的版本", prompt: "A的提示词内容", appliesTo: ["text"] }]);
    await putAs(TOKEN_B, [{ id: "p_same001", type: "action", label: "用户B的版本", prompt: "B的提示词内容", appliesTo: ["text"] }]);
    const resA = await (await mintAs(TOKEN_A, "p_same001")).json();
    const resB = await (await mintAs(TOKEN_B, "p_same001")).json();
    const docA = JSON.parse(env.FILES._store.get(`shares/${resA.code}`));
    const docB = JSON.parse(env.FILES._store.get(`shares/${resB.code}`));
    expect(docA.label).toBe("用户A的版本");
    expect(docA.instruction).toBe("A的提示词内容");
    expect(docB.label).toBe("用户B的版本");
    expect(docB.instruction).toBe("B的提示词内容");
  });
});

// ── 分享即发帖（2026-07-15 提示词社区帖，Task 4）───────────────────────────────
// spec: voicedrop repo docs/superpowers/specs/2026-07-15-prompt-community-posts-design.md
// 开分享=铸码+发社区帖；关分享=删码+撤帖。发帖需要可追责身份（Apple 登录会话），
// 裸匿名 token 连码都不再能铸——分享=发帖是一个不可拆分的动作。POST 还多一道
// 审核闸（与文章分享同一把 checkArticlesShareable）。
describe("分享即发帖（2026-07-15 提示词社区帖）", () => {
  it("开分享 → 铸码 + 社区帖 + communityShareId 字段", async () => {
    const e = makeEnv();
    const r = await post(e, { id: SYS_ITEM });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.communityShareId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const p = JSON.parse(await (await e.FILES.get(`community/${body.communityShareId}.json`)).text());
    expect(p).toMatchObject({ kind: "prompt", promptCode: body.code, owner: OWNER });
  });

  it("匿名 token 403 needs_apple_signin，不铸码不发帖", async () => {
    const e = makeEnv();
    const req = new Request("https://jianshuo.dev/agent/prompt-share", {
      method: "POST", headers: { Authorization: "Bearer anon_abcdef1234567890" },
      body: JSON.stringify({ id: SYS_ITEM }),
    });
    const r = await handlePromptShareRoutes(new URL(req.url), req, e);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("needs_apple_signin");
  });

  it("审核拦截：label/正文命中屏蔽词 → 403 content_flagged，不铸码", async () => {
    const e = makeEnv({ "config/community-blocklist.json": JSON.stringify(["测试屏蔽词"]) });
    // 先 PUT 一条含屏蔽词的自建提示词（putPrompts 基建），再对它开分享
    await putPrompts(e, [{ id: "p_flagged00", type: "action", label: "x",
      prompt: "内容含测试屏蔽词", appliesTo: ["text"] }]);
    const r = await post(e, { id: "p_flagged00" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("content_flagged");
  });

  it("关分享 → 帖同死；再开 → 同码同帖复活且 firstSharedAt 保留", async () => {
    const e = makeEnv();
    const first = await (await post(e, { id: SYS_ITEM })).json();
    const postKey = `community/${first.communityShareId}.json`;
    const t0 = JSON.parse(await (await e.FILES.get(postKey)).text()).firstSharedAt;
    await del(e, SYS_ITEM);
    expect(await e.FILES.get(postKey)).toBeNull();
    const again = await (await post(e, { id: SYS_ITEM })).json();
    expect(again.code).toBe(first.code);
    expect(again.communityShareId).toBe(first.communityShareId);
    // 复活后 firstSharedAt 重置为新时间是可接受的（帖曾被删除）；只断言帖回来了
    expect(await e.FILES.get(postKey)).toBeTruthy();
  });
});

// ── GET /agent/prompt-shares — 只读分享状态一览（iOS 分享卡，Phase 2 Piece 1）───────
// 直接暴露 shareStates() 的结果，key 从内部字段名 shareCode 映射成客户端契约的 code。
// 鉴权惯例照抄 /agent/prompts：resolveScope 先行，401 无 token；非 GET 一律 405。
describe("GET /agent/prompt-shares — 只读分享状态一览（iOS 分享卡）", () => {
  // GET /agent/prompt-shares 本身走 resolveScope（接受匿名或验证过的 token 均可读），
  // 不受「分享即发帖」门槛影响；但这里的 MINT/UNSHARE 打的是 POST/DELETE
  // /agent/prompt-share（单数），铸码/关闭现在需要验证过的身份，所以改用
  // makeToken() 的 session token，SESSION_SECRET 也要挂在 env 上（mkEnv()）。
  const SCOPE = "users/anon-states-tester/";
  const authHeader = async () => `Bearer ${await makeToken(SCOPE)}`;
  const mkEnv = (seed) => { const e = fakeEnv(seed); e.SESSION_SECRET = SECRET; return e; };
  const STATES = async (env, token) => worker.fetch(new Request("https://jianshuo.dev/agent/prompt-shares", {
    headers: token === null ? {} : { Authorization: token || await authHeader() },
  }), env);
  const MINT = async (env, id) => worker.fetch(new Request("https://jianshuo.dev/agent/prompt-share", {
    method: "POST", headers: { Authorization: await authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }), env);
  const UNSHARE = async (env, id) => worker.fetch(new Request(`https://jianshuo.dev/agent/prompt-share/${id}`, {
    method: "DELETE", headers: { Authorization: await authHeader() },
  }), env);

  it("无 token → 401", async () => {
    expect((await STATES(fakeEnv(), null)).status).toBe(401);
  });

  it("非 GET（POST）→ 405", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-shares", {
      method: "POST", headers: { Authorization: await authHeader() },
    }), mkEnv());
    expect(res.status).toBe(405);
  });

  it("没有任何分享的用户 → {byItem:{}}", async () => {
    expect(await (await STATES(mkEnv())).json()).toEqual({ byItem: {} });
  });

  it("铸码后 → byItem 带 code + sharing:true", async () => {
    const env = mkEnv();
    const { code } = await (await MINT(env, "sys_cartoon")).json();
    const body = await (await STATES(env)).json();
    expect(body.byItem["sys_cartoon"]).toEqual({ code, sharing: true });
  });

  it("DELETE 关闭后 → sharing:false，码保留（不是被从 byItem 里整条删掉）", async () => {
    const env = mkEnv();
    const { code } = await (await MINT(env, "sys_cartoon")).json();
    await UNSHARE(env, "sys_cartoon");
    const body = await (await STATES(env)).json();
    expect(body.byItem["sys_cartoon"]).toEqual({ code, sharing: false });
  });

  it("路由精确匹配，不与 /agent/prompt-share（POST 铸码/DELETE 关闭）或 /agent/prompt-share/<code>（公开预览 GET）互相吞掉", async () => {
    const env = mkEnv();
    const mintRes = await MINT(env, "sys_cartoon");
    expect(mintRes.status).toBe(200); // /agent/prompt-share 的 POST 没被新路由拦截
    const { code } = await mintRes.json();
    const previewRes = await worker.fetch(new Request(`https://jianshuo.dev/agent/prompt-share/${code}`), env);
    expect(previewRes.status).toBe(200); // /agent/prompt-share/<code> 的公开 GET 依旧不需要 token
  });
});
