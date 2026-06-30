// test/usage_routes.test.js
// vi.mock is hoisted by vitest before static imports, so this prevents the real
// `agents` package (which imports cloudflare:email / cloudflare:workers) from
// ever being loaded — the same pattern used for any CF-only module in this suite.
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { fakeD1, usageSql } from "./fakes.js";
import { handleUsageRoute } from "../src/index.js";

const SQL = usageSql();
function req(path, { method = "GET", token } = {}) {
  return new Request("https://jianshuo.dev" + path, { method, headers: token ? { Authorization: "Bearer " + token } : {} });
}

describe("usage routes", () => {
  it("balance route lazily creates account and returns ~500 算力", async () => {
    const env = { USAGE: fakeD1(SQL), SESSION_SECRET: "" }; // anon token path
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/balance"), req("/agent/usage/balance", { token: "anon_unittesttoken_abcdefghijklmnop" }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Math.round(body.suanli)).toBe(500);
  });
  it("non-usage path returns null (delegates to normal dispatch)", async () => {
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/edit"), req("/agent/edit"), {});
    expect(r).toBeNull();
  });
  it("admin grant requires FILES_TOKEN", async () => {
    const env = { USAGE: fakeD1(SQL), FILES_TOKEN: "admintok" };
    const bad = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant"), req("/agent/usage/grant", { method: "POST", token: "nope" }), env);
    expect(bad.status).toBe(401);
  });
  it("balance route returns live bucket balance, not the stale cached column", async () => {
    const db = fakeD1(usageSql());
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_unittesttoken_abcdefghijklmnop";
    // Bootstrap the account (creates the 500-算力 signup bucket + caches balance_uy=SIGNUP_GRANT_UY)
    await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/balance"),
      req("/agent/usage/balance", { token: tok }), env);
    // Expire every bucket: live sum is now 0, but account.balance_uy still caches 500
    await db.prepare("UPDATE bucket SET expires_at=1").bind().run();
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/balance"),
      req("/agent/usage/balance", { token: tok }), env);
    const body = await r.json();
    expect(body.suanli).toBe(0); // live=0; the old cached-column path would return 500
  });
  it("admin accounts lists live (bucket) balance", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    // 触发一个用户的 signup（500 算力桶）
    await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/balance"),
      req("/agent/usage/balance", { token: "anon_unittesttoken_abcdefghijklmnop" }), env);
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/admin/accounts"),
      req("/agent/usage/admin/accounts", { token: "admintok" }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.accounts.length).toBe(1);
    expect(Math.round(body.accounts[0].balance_suanli)).toBe(500);
  });
  it("admin grant writes a campaign bucket with default 90d expiry and echoes cost", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant"),
      new Request("https://jianshuo.dev/agent/usage/grant", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ user_sub: "users/anon-c/", suanli: 1000, reason: "spring" }),
      }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Math.round(body.cost_yuan * 100) / 100).toBe(Math.round((1000 / 23) * 100) / 100); // ≈43.48
    const row = env.USAGE.prepare("SELECT source,expires_at FROM bucket WHERE user_sub='users/anon-c/' AND source LIKE 'campaign:%'").first();
    expect(row.source).toBe("campaign:spring");
    expect(row.expires_at).toBeGreaterThan(0); // 盖了过期日（90 天后）
  });
  it("batch grant fans out to explicit user_subs", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant/batch"),
      new Request("https://jianshuo.dev/agent/usage/grant/batch", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ user_subs: ["users/anon-a/", "users/anon-b/"], suanli: 500, reason: "promo" }),
      }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.count).toBe(2);
    expect(body.suanli_each).toBe(500);
    expect(body.cost_yuan).toBeCloseTo(43.48, 2); // r2(500*2/23)
    expect(typeof body.expires_at).toBe("number");
    const n = env.USAGE.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='campaign:promo'").first().n;
    expect(n).toBe(2);
  });
  it("batch grant all:true fans out to every account", async () => {
    const db = fakeD1(usageSql());
    const env = { USAGE: db, FILES_TOKEN: "admintok" };
    // seed two accounts directly so allAccounts() returns them
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-a/", 0, 0, 0, 1, 1).run();
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-b/", 0, 0, 0, 1, 1).run();
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant/batch"),
      new Request("https://jianshuo.dev/agent/usage/grant/batch", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ suanli: 100, all: true }),
      }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.count).toBe(2);
    const n = db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='campaign:manual'").bind().first().n;
    expect(n).toBe(2);
  });
  it("batch grant requires a target set", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant/batch"),
      new Request("https://jianshuo.dev/agent/usage/grant/batch", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ suanli: 500 }),
      }), env);
    expect(r.status).toBe(400);
  });
});
