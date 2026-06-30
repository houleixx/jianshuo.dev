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
});
