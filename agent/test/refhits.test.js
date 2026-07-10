// test/refhits.test.js — IP 指纹归因：写入 + 唯一匹配查询
import { describe, it, expect, beforeEach } from "vitest";
import { fakeEnv } from "./fakes.js";
import { ipHash, writeRefhit, lookupRefhit } from "../../functions/lib/refhits.js";

const SECRET = "test-secret";
const NOW = 1800000000000;
let env;
beforeEach(() => { env = fakeEnv(); });

describe("refhits", () => {
  it("hashes ip, no plaintext", async () => {
    const h = await ipHash("1.2.3.4", SECRET);
    expect(h).toHaveLength(16);
    expect(h).not.toContain(".");
  });
  it("lookup finds unique owner within 24h", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokA", NOW - 3600_000);
    const hit = await lookupRefhit(env, "1.2.3.4", SECRET, NOW);
    expect(hit).toEqual({ owner: "users/anon-a/", token: "tokA" });
  });
  it("returns null when two owners share the ip (CGNAT — 宁漏不错)", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokA", NOW - 3600_000);
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-b/", "tokB", NOW - 1800_000);
    expect(await lookupRefhit(env, "1.2.3.4", SECRET, NOW)).toBeNull();
  });
  it("ignores hits older than 24h and other ips", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokA", NOW - 25 * 3600_000);
    await writeRefhit(env, "5.6.7.8", SECRET, "users/anon-b/", "tokB", NOW - 3600_000);
    expect(await lookupRefhit(env, "1.2.3.4", SECRET, NOW)).toBeNull();
  });
  it("same owner twice still matches (not ambiguous)", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokA", NOW - 3600_000);
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokB", NOW - 1800_000);
    const hit = await lookupRefhit(env, "1.2.3.4", SECRET, NOW);
    expect(hit && hit.owner).toBe("users/anon-a/");
  });
  it("no ip / no secret → safe null", async () => {
    expect(await lookupRefhit(env, null, SECRET, NOW)).toBeNull();
    expect(await lookupRefhit(env, "1.2.3.4", "", NOW)).toBeNull();
  });
});
