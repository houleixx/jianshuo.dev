import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import worker from "../src/index.js";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";
import { imageCostUY } from "../src/usage.js";
import { balanceUY } from "../src/usage_store.js";

const SCOPE = "users/sub123/";
const OLD = "photos/171/171.jpg";
const NEW = "photos/171/999.png";

async function env0({ withOldPhoto = true } = {}) {
  const seed = withOldPhoto ? { [SCOPE + OLD]: "OLDBYTES" } : {};
  const env = fakeEnv(seed);
  env.USAGE = fakeD1(usageSql());
  const now = 1;
  await env.USAGE.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(SCOPE,0,0,0,now,now).run();
  await env.USAGE.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(SCOPE, 1000000, 1000000, "seed", now, null).run();
  env.PAINT_CALLBACK_TOKEN = "cbtok";
  env.PAINT_BASE = "https://paint.test";
  return env;
}
function req(body, token = "cbtok") {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  return new Request("https://vd.test/agent/paint-callback", { method: "POST", headers: h, body: JSON.stringify(body) });
}
const meta = { scope: SCOPE, oldKey: OLD, newKey: NEW };

describe("POST /agent/paint-callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("401 without token", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", callback_meta: meta }, ""), env);
    expect(res.status).toBe(401);
  });

  it("done: writes ad bytes to newKey and debits imageCostUY", async () => {
    const env = await env0();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: "ADBYTES", headers: { get: () => "image/png" } })));
    const before = await balanceUY(env.USAGE, SCOPE, 2);
    const res = await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/results/x.png", callback_meta: meta }), env);
    expect(res.status).toBe(200);
    expect(await env.FILES.head(SCOPE + NEW)).toBeTruthy();
    const after = await balanceUY(env.USAGE, SCOPE, 2);
    expect(before - after).toBe(imageCostUY());
  });

  it("failed: writes original copy, no debit", async () => {
    const env = await env0();
    const before = await balanceUY(env.USAGE, SCOPE, 2);
    const res = await worker.fetch(req({ job_id: "j1", status: "failed", callback_meta: meta }), env);
    expect(res.status).toBe(200);
    const put = await env.FILES.get(SCOPE + NEW);
    expect(await put.text()).toBe("OLDBYTES");
    expect(await balanceUY(env.USAGE, SCOPE, 2)).toBe(before); // unchanged
  });

  it("idempotent: second done callback is a no-op (no double debit)", async () => {
    const env = await env0();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: "ADBYTES", headers: { get: () => "image/png" } })));
    const b0 = await balanceUY(env.USAGE, SCOPE, 2);
    await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/x.png", callback_meta: meta }), env);
    const b1 = await balanceUY(env.USAGE, SCOPE, 2);
    await worker.fetch(req({ job_id: "j1", status: "done", result_url: "https://paint.test/x.png", callback_meta: meta }), env);
    const b2 = await balanceUY(env.USAGE, SCOPE, 2);
    expect(b0 - b1).toBe(imageCostUY());
    expect(b1).toBe(b2); // no second debit
  });

  it("401 with a wrong (present) token", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", callback_meta: meta }, "WRONGTOKEN"), env);
    expect(res.status).toBe(401);
  });
  it("400 on bad scope (not users/<id>/)", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", result_url: "https://paint.test/x.png", callback_meta: { ...meta, scope: "evil/" } }), env);
    expect(res.status).toBe(400);
  });
  it("400 on bad newKey (not photos/*.png)", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", result_url: "https://paint.test/x.png", callback_meta: { ...meta, newKey: "WECHAT.json" } }), env);
    expect(res.status).toBe(400);
  });
  it("400 when result_url is not from the paint base (SSRF pin)", async () => {
    const env = await env0();
    const res = await worker.fetch(req({ status: "done", result_url: "https://evil.example/x.png", callback_meta: meta }), env);
    expect(res.status).toBe(400);
  });
});
