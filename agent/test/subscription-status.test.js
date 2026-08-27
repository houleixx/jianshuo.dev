import { describe, it, expect } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { handleSubscriptionStatusRoute } from "../src/subscription-status.js";

const SQL = usageSql();
const TOK = "anon_unittesttoken_abcdefghijklmnop";
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

const call = (env) => handleSubscriptionStatusRoute(
  new URL("https://jianshuo.dev/agent/subscription/status"),
  new Request("https://jianshuo.dev/agent/subscription/status", { headers: { Authorization: `Bearer ${TOK}` } }), env, NOW,
);

describe("GET /agent/subscription/status", () => {
  it("只返回一个有效订阅与一个到期时间；同时存在时 Apple 优先展示", async () => {
    const db = fakeD1(SQL); const scope = await anonScopeFromToken(TOK);
    await db.prepare("INSERT INTO iap_sub (original_txn_id,user_sub,product_id,expires_date,status,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("ios-1", scope, "monthly_19_9", NOW + 20, "active", NOW).run();
    await db.prepare("INSERT INTO wechat_sub (contract_code,user_sub,plan_id,status,period_end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind("wechat-1", scope, "plan", "active", NOW + 30, NOW, NOW).run();
    expect(await (await call({ USAGE: db, SESSION_SECRET: "" })).json())
      .toEqual({ active: true, provider: "apple", expires_date: NOW + 20 });
  });

  it("仅微信有效时返回微信；无有效订阅时只返回空摘要", async () => {
    const db = fakeD1(SQL); const scope = await anonScopeFromToken(TOK);
    await db.prepare("INSERT INTO wechat_sub (contract_code,user_sub,plan_id,status,period_end_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind("wechat-1", scope, "plan", "active", NOW + 30, NOW, NOW).run();
    expect(await (await call({ USAGE: db, SESSION_SECRET: "" })).json())
      .toEqual({ active: true, provider: "wechat", expires_date: NOW + 30 });
    const empty = fakeD1(SQL);
    expect(await (await call({ USAGE: empty, SESSION_SECRET: "" })).json())
      .toEqual({ active: false, provider: null, expires_date: null });
  });
});
