// test/refhits-view.test.js — GET /agent/referral/refhits 访客 IP 一览调试页。
// key 必须与 worker secret REFHITS_VIEW_KEY 全等；未配 secret = 功能关闭（401）。
import { describe, it, expect, beforeEach } from "vitest";
import { fakeEnv } from "./fakes.js";
import { handleReferralRoutes } from "../src/referral.js";
import { writeRefhit } from "../../functions/lib/refhits.js";

const SECRET = "test-secret";
const KEY = "viewkey-123";
const NOW = 1800000000000;
let env;
beforeEach(() => { env = fakeEnv(); env.SESSION_SECRET = SECRET; env.REFHITS_VIEW_KEY = KEY; });

const view = (key) =>
  handleReferralRoutes(
    new URL(`https://jianshuo.dev/agent/referral/refhits${key ? `?key=${key}` : ""}`),
    { method: "GET" }, env);

describe("GET /agent/referral/refhits", () => {
  it("无 key / 错 key → 401，不漏任何数据", async () => {
    expect((await view(null)).status).toBe(401);
    expect((await view("wrong")).status).toBe(401);
  });
  it("未配 REFHITS_VIEW_KEY = 功能关闭（即使 key 恰好为空也 401）", async () => {
    delete env.REFHITS_VIEW_KEY;
    expect((await view("")).status).toBe(401);
  });
  it("对 key → 200 HTML，列出指纹、次数与来源码", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "AE209A", NOW - 3600_000);
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "AE209A", NOW - 1800_000);
    const r = await view(KEY);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("1.2.3.4");     // DEBUG_PLAINTEXT_IP 开着时指纹即明文 IP
    expect(body).toContain("AE209A");      // 最新一条记录的来源码
    expect(body).toContain("分享页访客 IP");
  });
});
