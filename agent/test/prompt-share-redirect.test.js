// test/prompt-share-redirect.test.js — 导入件再分享溯源转发（prompt 不变码不变）。
// spec：voicedrop repo docs/superpowers/specs/2026-07-22-prompt-share-reshare-redirect-design.md
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import { coreLoadPromptShares, coreUpsertPromptShare, coreDeletePromptShare, coreMintedToday, coreDeleteUserData } from "../../functions/lib/core-db.js";
import { hmacSign, b64url } from "../../functions/lib/auth.js";
import { handlePromptShareRoutes, shareStates } from "../src/prompt-share.js";
import { handlePromptMarket } from "../src/prompt-market.js";
import worker from "../src/index.js";

const SECRET = "test-secret";
async function tok(scope) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, apple: true }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}
const IMPORTER = "users/anon-importer1/";
function env2(seed = {}) { const e = fakeEnv(seed); e.SESSION_SECRET = SECRET; return e; }
// 原作者 other-author 的活跃分享副本（写穿格式，与 prompt-share.js sharedDocFor 对齐）
const ORIGIN_CODE = "4563";
const originDoc = (over = {}) => JSON.stringify({
  type: "prompt", sub: "other-author", itemId: "p_origin1",
  label: "更毒舌", instruction: "把它改得更毒舌，观点不变。", appliesTo: ["text"],
  importCount: 5, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", ...over,
});
async function putTree(e, items) {
  const req = new Request("https://jianshuo.dev/agent/prompts", {
    method: "PUT",
    headers: { Authorization: `Bearer ${await tok(IMPORTER)}`, "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return worker.fetch(req, e);
}
async function share(e, id) {
  const req = new Request("https://jianshuo.dev/agent/prompt-share", {
    method: "POST",
    headers: { Authorization: `Bearer ${await tok(IMPORTER)}` },
    body: JSON.stringify({ id }),
  });
  return handlePromptShareRoutes(new URL(req.url), req, e);
}
async function unshare(e, id) {
  const req = new Request(`https://jianshuo.dev/agent/prompt-share/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${await tok(IMPORTER)}` },
  });
  return handlePromptShareRoutes(new URL(req.url), req, e);
}
// 导入件（改过正文版）：importedFrom 在、正文与 originDoc 不同
const editedImport = { id: "p_imp001", type: "action", label: "更毒舌", prompt: "改得更毒舌，再加点阴阳怪气。", appliesTo: ["text"], importedFrom: ORIGIN_CODE };

describe("migration 0004: prompt_shares.borrowed", () => {
  it("borrowed 行可与原作者行同码共存；自有码（borrowed=0）唯一性保持", () => {
    const d = fakeD1(coreSql());
    const ins = (sub, item, code, borrowed) =>
      d.prepare("INSERT INTO prompt_shares (user_sub, item_id, code, created_at, borrowed) VALUES (?,?,?,?,?)")
        .bind(sub, item, code, "2026-07-22T00:00:00.000Z", borrowed).run();
    ins("users/a/", "p_1", "4563", 0);            // 原作者自有码
    ins("users/b/", "p_2", "4563", 1);            // 导入者 borrowed 行，同码 OK
    expect(() => ins("users/c/", "p_3", "4563", 0)).toThrow(); // 自有码撞唯一
  });
});

describe("core-db borrowed 读写", () => {
  const envWithCore = () => { const e = fakeEnv(); e.CORE = fakeD1(coreSql()); return e; };
  const today = new Date().toISOString().slice(0, 10);

  it("upsert(borrowed=true) → load 带 borrowed:true；默认 upsert 不带", async () => {
    const e = envWithCore();
    await coreUpsertPromptShare(e, "users/b/", "p_1", "4563", "2026-07-22T00:00:00.000Z", true);
    await coreUpsertPromptShare(e, "users/b/", "p_2", "7654", "2026-07-22T00:00:00.000Z");
    const { byItem } = await coreLoadPromptShares(e, "users/b/");
    expect(byItem.p_1).toEqual({ code: "4563", createdAt: "2026-07-22T00:00:00.000Z", borrowed: true });
    expect(byItem.p_2).toEqual({ code: "7654", createdAt: "2026-07-22T00:00:00.000Z" });
  });
  it("同一 item 从 borrowed 升级为自有码：upsert 覆盖清掉 borrowed", async () => {
    const e = envWithCore();
    await coreUpsertPromptShare(e, "users/b/", "p_1", "4563", "2026-07-22T00:00:00.000Z", true);
    await coreUpsertPromptShare(e, "users/b/", "p_1", "8888", "2026-07-22T01:00:00.000Z");
    const { byItem } = await coreLoadPromptShares(e, "users/b/");
    expect(byItem.p_1).toEqual({ code: "8888", createdAt: "2026-07-22T01:00:00.000Z" });
  });
  it("coreDeletePromptShare 删行", async () => {
    const e = envWithCore();
    await coreUpsertPromptShare(e, "users/b/", "p_1", "4563", "2026-07-22T00:00:00.000Z", true);
    await coreDeletePromptShare(e, "users/b/", "p_1");
    const { byItem } = await coreLoadPromptShares(e, "users/b/");
    expect(byItem.p_1).toBeUndefined();
  });
  it("coreMintedToday 不数 borrowed 行", async () => {
    const e = envWithCore();
    await coreUpsertPromptShare(e, "users/b/", "p_1", "4563", `${today}T00:00:00.000Z`, true);
    await coreUpsertPromptShare(e, "users/b/", "p_2", "7654", `${today}T00:00:00.000Z`);
    expect(await coreMintedToday(e, "users/b/", today)).toBe(1);
  });
});

describe("effectiveLeaf importedFrom 透传", () => {
  it("改过正文的导入件分享 → 铸自有码；写穿副本无 importedFrom 字段", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [editedImport]);
    const r = await share(e, "p_imp001");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.code).not.toBe(ORIGIN_CODE);
    expect(j.original).toBeUndefined();
    const doc = JSON.parse(e.FILES._store.get(`shares/${j.code}`));
    expect(doc.sub).toBe("anon-importer1");
    expect(doc.importedFrom).toBeUndefined();
  });
});

describe("溯源转发（POST）", () => {
  // 未改导入件：正文与 originDoc 完全一致
  const cleanImport = { id: "p_imp002", type: "action", label: "随便改名也行", prompt: "把它改得更毒舌，观点不变。", appliesTo: ["text"], importedFrom: ORIGIN_CODE };

  it("未改导入件 → 返回原码 original:true；不写穿原副本；不占 mintLog；索引落 borrowed", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    const j = await (await share(e, "p_imp002")).json();
    expect(j.code).toBe(ORIGIN_CODE);
    expect(j.original).toBe(true);
    expect(j.created).toBe(false);
    expect(j.sharing).toBe(true);
    expect(j.url).toBe(`https://voicedrop.cn/${ORIGIN_CODE}`);
    expect(typeof j.author).toBe("string");
    const origin = JSON.parse(e.FILES._store.get(`shares/${ORIGIN_CODE}`));
    expect(origin.sub).toBe("other-author");        // 副本没被写穿成导入者
    expect(origin.importCount).toBe(5);
    const idx = JSON.parse(e.FILES._store.get(`${IMPORTER}prompt-shares.json`));
    expect(idx.byItem.p_imp002).toMatchObject({ code: ORIGIN_CODE, borrowed: true });
    expect(idx.mintLog).toHaveLength(0);            // 不占日上限
  });
  it("幂等重放：再 POST 一次仍返回原码，副本仍是原作者的", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    await share(e, "p_imp002");
    const j2 = await (await share(e, "p_imp002")).json();
    expect(j2.code).toBe(ORIGIN_CODE);
    expect(j2.original).toBe(true);
    expect(JSON.parse(e.FILES._store.get(`shares/${ORIGIN_CODE}`)).sub).toBe("other-author");
  });
  it("原分享已关 → 正常铸自有码", async () => {
    const e = env2(); // 不 seed shares/<原码>
    await putTree(e, [cleanImport]);
    const j = await (await share(e, "p_imp002")).json();
    expect(j.code).not.toBe(ORIGIN_CODE);
    expect(j.original).toBeUndefined();
    expect(j.created).toBe(true);
    expect(JSON.parse(e.FILES._store.get(`shares/${j.code}`)).sub).toBe("anon-importer1");
  });
  it("原作者后来改了原件（快照不再等同）→ 铸自有码", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc({ instruction: "原作者升级过的正文。" }) });
    await putTree(e, [cleanImport]);
    const j = await (await share(e, "p_imp002")).json();
    expect(j.code).not.toBe(ORIGIN_CODE);
    expect(j.created).toBe(true);
  });
  it("borrowed 之后导入者改了正文再 POST → 铸自有码替换 entry", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    await share(e, "p_imp002");                        // 先转发
    await putTree(e, [{ ...cleanImport, prompt: "我自己改过的版本。" }]);
    // 保存同步（refreshPromptShare）不得把导入者的新正文写穿进原作者的副本
    expect(JSON.parse(e.FILES._store.get(`shares/${ORIGIN_CODE}`)).instruction).toBe("把它改得更毒舌，观点不变。");
    const j = await (await share(e, "p_imp002")).json();
    expect(j.code).not.toBe(ORIGIN_CODE);
    expect(j.created).toBe(true);
    const idx = JSON.parse(e.FILES._store.get(`${IMPORTER}prompt-shares.json`));
    expect(idx.byItem.p_imp002.code).toBe(j.code);
    expect(idx.byItem.p_imp002.borrowed).toBeUndefined();
    expect(JSON.parse(e.FILES._store.get(`shares/${ORIGIN_CODE}`)).sub).toBe("other-author"); // 原副本始终没动
  });
  it("DELETE borrowed → 原作者副本完好；自己索引 entry 消失；再 POST 重新转发", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [{ ...cleanImport, id: "p_imp003" }]);
    await share(e, "p_imp003");
    const r = await unshare(e, "p_imp003");
    const j = await r.json();
    expect(j.sharing).toBe(false);
    expect(e.FILES._store.get(`shares/${ORIGIN_CODE}`)).toBeTruthy();   // 原作者分享没被删
    const idx = JSON.parse(e.FILES._store.get(`${IMPORTER}prompt-shares.json`));
    expect(idx.byItem.p_imp003).toBeUndefined();
    const j2 = await (await share(e, "p_imp003")).json();               // 再开 → 重新转发
    expect(j2.code).toBe(ORIGIN_CODE);
    expect(j2.original).toBe(true);
  });
  it("DELETE borrowed 连 D1 行一起删", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    e.CORE = fakeD1(coreSql());
    await putTree(e, [{ ...cleanImport, id: "p_imp003" }]);
    await share(e, "p_imp003");
    await unshare(e, "p_imp003");
    const { byItem } = await coreLoadPromptShares(e, IMPORTER);
    expect(byItem.p_imp003).toBeUndefined();
  });
  it("shareStates：borrowed 条目 sharing 随 shares/<原码> 存活联动", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [{ ...cleanImport, id: "p_imp003" }]);
    await share(e, "p_imp003");
    let st = await shareStates(e, IMPORTER);
    expect(st.p_imp003).toEqual({ shareCode: ORIGIN_CODE, sharing: true, borrowed: true });
    e.FILES._store.delete(`shares/${ORIGIN_CODE}`);   // 原作者关分享
    st = await shareStates(e, IMPORTER);
    expect(st.p_imp003).toEqual({ shareCode: ORIGIN_CODE, sharing: false, borrowed: true });
  });
  it("带 CORE 时 borrowed 行落 D1 且不占 coreMintedToday", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    e.CORE = fakeD1(coreSql());
    await putTree(e, [cleanImport]);
    await share(e, "p_imp002");
    const { byItem } = await coreLoadPromptShares(e, IMPORTER);
    expect(byItem.p_imp002).toMatchObject({ code: ORIGIN_CODE, borrowed: true });
    const today = new Date().toISOString().slice(0, 10);
    expect(await coreMintedToday(e, IMPORTER, today)).toBe(0);
  });
});

describe("review 修复（2026-07-22 code-review）", () => {
  const cleanImport = { id: "p_imp004", type: "action", label: "更毒舌", prompt: "把它改得更毒舌，观点不变。", appliesTo: ["text"], importedFrom: ORIGIN_CODE };
  const legacyCoreSql = () => ["0001_core.sql", "0002_articles_recordings.sql", "0003_identity_push_reports.sql"]
    .map((n) => readFileSync(fileURLToPath(new URL("../migrations-core/" + n, import.meta.url)), "utf8")).join("\n");

  it("V1: coreDeleteUserData 不清 borrowed 码的 share_stats（那是原作者的计数）", async () => {
    const e = env2(); e.CORE = fakeD1(coreSql());
    const ins = (sub, item, code, borrowed) =>
      e.CORE.prepare("INSERT INTO prompt_shares (user_sub, item_id, code, created_at, borrowed) VALUES (?,?,?,?,?)")
        .bind(sub, item, code, "2026-07-22T00:00:00.000Z", borrowed).run();
    ins(IMPORTER, "p_own01", "7654", 0);
    ins(IMPORTER, "p_imp004", ORIGIN_CODE, 1);
    e.CORE.prepare("INSERT INTO share_stats (code, import_count, updated_at) VALUES (?,?,?)").bind(ORIGIN_CODE, 9, 0).run();
    e.CORE.prepare("INSERT INTO share_stats (code, import_count, updated_at) VALUES (?,?,?)").bind("7654", 3, 0).run();
    await coreDeleteUserData(e, IMPORTER);
    expect(e.CORE.prepare("SELECT import_count AS n FROM share_stats WHERE code=?").bind(ORIGIN_CODE).first("n")).toBe(9); // 原作者计数健在
    expect(e.CORE.prepare("SELECT COUNT(*) AS n FROM share_stats WHERE code=?").bind("7654").first("n")).toBe(0);          // 自有码计数清掉
    expect(e.CORE.prepare("SELECT COUNT(*) AS n FROM prompt_shares WHERE user_sub=?").bind(IMPORTER).first("n")).toBe(0);  // 本人行全删
  });

  it("V2: DELETE borrowed 时 D1 删行失败 → 500，不谎报已关", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    e.CORE = fakeD1(coreSql());
    await putTree(e, [cleanImport]);
    await share(e, "p_imp004");
    const rawPrepare = e.CORE.prepare.bind(e.CORE);
    e.CORE.prepare = (sql) => { if (/DELETE FROM prompt_shares WHERE user_sub=\? AND item_id=\?/.test(sql)) throw new Error("d1 boom"); return rawPrepare(sql); };
    expect((await unshare(e, "p_imp004")).status).toBe(500);
    e.CORE.prepare = rawPrepare;
    expect((await unshare(e, "p_imp004")).status).toBe(200); // 恢复后重试成功
  });

  it("V3: 转发落索引两路全失败 → 500，不返回假 sharing:true", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() }); // 无 CORE：D1 路必 false
    await putTree(e, [cleanImport]);
    const rawPut = e.FILES.put.bind(e.FILES);
    e.FILES.put = async (k, v) => { if (String(k).endsWith("prompt-shares.json")) throw new Error("r2 boom"); return rawPut(k, v); };
    expect((await share(e, "p_imp004")).status).toBe(500);
    e.FILES.put = rawPut;
    const j = await (await share(e, "p_imp004")).json(); // 恢复后转发成功
    expect(j.code).toBe(ORIGIN_CODE);
  });

  it("V4: 读原码副本时 R2 抛错 → 500 重试，不误判「已关」铸新码", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    const rawGet = e.FILES.get.bind(e.FILES);
    e.FILES.get = async (k) => { if (k === `shares/${ORIGIN_CODE}`) throw new Error("r2 blip"); return rawGet(k); };
    expect((await share(e, "p_imp004")).status).toBe(500);
    e.FILES.get = rawGet;
    const j = await (await share(e, "p_imp004")).json();
    expect(j.code).toBe(ORIGIN_CODE); // 抖动过后仍是转发，归属没有被固化成自有码
    expect(j.original).toBe(true);
  });

  it("V5: 导入者改文保存 → 保存同步撤掉 borrowed 条目（开关如实归零）", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    await share(e, "p_imp004");
    await putTree(e, [{ ...cleanImport, prompt: "我自己改过的版本。" }]);
    const idx = JSON.parse(e.FILES._store.get(`${IMPORTER}prompt-shares.json`));
    expect(idx.byItem.p_imp004).toBeUndefined();                       // 转发关系失效即撤
    expect(await shareStates(e, IMPORTER)).toEqual({});                // 分享卡不再显示分享中
    expect(e.FILES._store.get(`shares/${ORIGIN_CODE}`)).toBeTruthy();  // 原作者分享无恙
  });

  it("V5: 只改名不改正文 → borrowed 条目保持", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    await putTree(e, [cleanImport]);
    await share(e, "p_imp004");
    await putTree(e, [{ ...cleanImport, label: "新名字" }]);
    const idx = JSON.parse(e.FILES._store.get(`${IMPORTER}prompt-shares.json`));
    expect(idx.byItem.p_imp004).toMatchObject({ code: ORIGIN_CODE, borrowed: true });
  });

  it("V7: 超限原文的截断导入件未改动 → 仍转发原码", async () => {
    const longText = "毒".repeat(4500);
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc({ instruction: longText }) });
    await putTree(e, [{ ...cleanImport, prompt: "毒".repeat(4000) }]); // 导入截断后的快照
    const j = await (await share(e, "p_imp004")).json();
    expect(j.code).toBe(ORIGIN_CODE);
    expect(j.original).toBe(true);
  });

  it("V8: D1 COUNT 瞬时失败且 idx 来自 D1 → 回退数 R2 mintLog，日上限仍生效", async () => {
    const today = new Date().toISOString();
    const e = env2({
      "config/prompt-share.json": JSON.stringify({ dailyCapPerUser: 1 }),
      [`${IMPORTER}prompt-shares.json`]: JSON.stringify({ byItem: { p_other9: { code: "9871", createdAt: today } }, mintLog: [today] }),
    });
    e.CORE = fakeD1(coreSql());
    e.CORE.prepare("INSERT INTO prompt_shares (user_sub, item_id, code, created_at, borrowed) VALUES (?,?,?,?,?)")
      .bind(IMPORTER, "p_other9", "9871", today, 0).run();
    const rawPrepare = e.CORE.prepare.bind(e.CORE);
    e.CORE.prepare = (sql) => { if (/COUNT\(\*\)/.test(sql) && /created_at LIKE/.test(sql)) throw new Error("d1 count boom"); return rawPrepare(sql); };
    await putTree(e, [{ id: "p_fresh01", type: "action", label: "新条目", prompt: "全新正文。", appliesTo: ["text"] }]);
    expect((await share(e, "p_fresh01")).status).toBe(429); // 修复前这里会放行铸码
  });

  it("V6: 无 borrowed 列的旧库 → market 退回老 SQL 不 500；upsert 自有码退回 4 列写法", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    e.CORE = fakeD1(legacyCoreSql());
    e.CORE.prepare("INSERT INTO prompt_shares (user_sub, item_id, code, created_at) VALUES (?,?,?,?)")
      .bind("users/other-author/", "p_origin1", ORIGIN_CODE, "2026-07-22T00:00:00.000Z").run();
    const req = new Request("https://jianshuo.dev/agent/prompt-market", { headers: { Authorization: `Bearer ${await tok(IMPORTER)}` } });
    const r = await handlePromptMarket(new URL(req.url), req, e);
    expect(r.status).toBe(200);
    expect((await r.json()).items.some((i) => i.code === ORIGIN_CODE)).toBe(true);
    expect(await coreUpsertPromptShare(e, IMPORTER, "p_own02", "7654", "2026-07-22T01:00:00.000Z")).toBe(true);
    expect(e.CORE.prepare("SELECT code FROM prompt_shares WHERE user_sub=? AND item_id=?").bind(IMPORTER, "p_own02").first("code")).toBe("7654");
    expect(await coreUpsertPromptShare(e, IMPORTER, "p_imp004", ORIGIN_CODE, "2026-07-22T01:00:00.000Z", true)).toBe(false); // borrowed 没列可表达
  });
});

describe("prompt-market 排除 borrowed 行", () => {
  it("原作者一行 + 导入者 borrowed 行同码 → 市场只出一条", async () => {
    const e = env2({ [`shares/${ORIGIN_CODE}`]: originDoc() });
    e.CORE = fakeD1(coreSql());
    const ins = (sub, item, code, borrowed) =>
      e.CORE.prepare("INSERT INTO prompt_shares (user_sub, item_id, code, created_at, borrowed) VALUES (?,?,?,?,?)")
        .bind(sub, item, code, "2026-07-22T00:00:00.000Z", borrowed).run();
    ins("users/other-author/", "p_origin1", ORIGIN_CODE, 0);
    ins(IMPORTER, "p_imp009", ORIGIN_CODE, 1);
    const req = new Request("https://jianshuo.dev/agent/prompt-market", {
      headers: { Authorization: `Bearer ${await tok(IMPORTER)}` },
    });
    const r = await handlePromptMarket(new URL(req.url), req, e);
    const { items } = await r.json();
    expect(items.filter((i) => i.code === ORIGIN_CODE)).toHaveLength(1);
  });
});
