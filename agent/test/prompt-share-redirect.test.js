// test/prompt-share-redirect.test.js — 导入件再分享溯源转发（prompt 不变码不变）。
// spec：voicedrop repo docs/superpowers/specs/2026-07-22-prompt-share-reshare-redirect-design.md
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";

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
