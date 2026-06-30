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
});
