// test/prompt-share-redirect.test.js — 导入件再分享溯源转发（prompt 不变码不变）。
// spec：voicedrop repo docs/superpowers/specs/2026-07-22-prompt-share-reshare-redirect-design.md
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import { coreLoadPromptShares, coreUpsertPromptShare, coreDeletePromptShare, coreMintedToday } from "../../functions/lib/core-db.js";
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
