// test/prompt-share-redirect.test.js — 导入件再分享溯源转发（prompt 不变码不变）。
// spec：voicedrop repo docs/superpowers/specs/2026-07-22-prompt-share-reshare-redirect-design.md
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import { coreLoadPromptShares, coreUpsertPromptShare, coreDeletePromptShare, coreMintedToday } from "../../functions/lib/core-db.js";

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
