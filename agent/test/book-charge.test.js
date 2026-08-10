// test/book-charge.test.js — POST /agent/usage/book-charge（写书一口价 320 算力）
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { fakeD1, usageSql } from "./fakes.js";
import { handleUsageRoute } from "../src/index.js";
import { grantBucket } from "../src/usage_store.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { BOOK_SUANLI, suanliToUY } from "../src/usage.js";

const SQL = usageSql();
const PATH = "/agent/usage/book-charge";
function call(env, { token, body } = {}) {
  const req = new Request("https://jianshuo.dev" + PATH, {
    method: "POST",
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleUsageRoute(new URL("https://jianshuo.dev" + PATH), req, env);
}

describe("book-charge", () => {
  it("无 token → 401", async () => {
    const r = await call({ USAGE: fakeD1(SQL), SESSION_SECRET: "" });
    expect(r.status).toBe(401);
  });

  it("新账户只有注册赠送 200 算力 < 320 → 402 不扣", async () => {
    const db = fakeD1(SQL);
    const r = await call({ USAGE: db, SESSION_SECRET: "" }, { token: "anon_fresh_token_abcdefghijklmnop" });
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.error).toBe("no-credit");
    expect(body.need_suanli).toBe(BOOK_SUANLI);
    // 没有 spend 流水
    const spends = db.prepare("SELECT * FROM ledger WHERE kind='spend'").bind().all().results;
    expect(spends.length).toBe(0);
  });

  it("余额够 → 扣 320 记 book 流水返回新余额；dry 只验不扣", async () => {
    const db = fakeD1(SQL);
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_rich_token_abcdefghijklmnopqr";
    const scope = await anonScopeFromToken(tok);
    // 造数用当前时间——signup 桶带 365d 过期，用 ts=1 造会在路由的 Date.now() 视角下全过期
    await grantBucket(db, scope, suanliToUY(500), "campaign:test", null, Date.now()); // + signup 200 = 700
    // dry：过但不扣
    const dry = await call(env, { token: tok, body: { dry: true } });
    expect(dry.status).toBe(200);
    expect((await dry.json()).dry).toBe(true);
    expect(db.prepare("SELECT * FROM ledger WHERE kind='spend'").bind().all().results.length).toBe(0);
    // 真扣
    const r = await call(env, { token: tok, body: { seed: "熵" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.charged_suanli).toBe(BOOK_SUANLI);
    expect(Math.round(body.suanli)).toBe(700 - BOOK_SUANLI);
    const spends = db.prepare("SELECT reason, detail FROM ledger WHERE kind='spend'").bind().all().results;
    expect(spends.length).toBe(1);
    expect(spends[0].reason).toBe("book");
    expect(JSON.parse(spends[0].detail).seed).toBe("熵");
  });
});
