// test/refhits.test.js — IP 指纹归因：写入 + 唯一匹配查询
import { describe, it, expect, beforeEach } from "vitest";
import { fakeEnv } from "./fakes.js";
import { ipHash, writeRefhit, lookupRefhit, DEBUG_PLAINTEXT_IP } from "../../functions/lib/refhits.js";

const SECRET = "test-secret";
const NOW = 1800000000000;
let env;
beforeEach(() => { env = fakeEnv(); });

describe("refhits", () => {
  // 断言跟着 DEBUG_PLAINTEXT_IP 开关走：调试期明文 IP，翻回后 16 位哈希——
  // 两种状态下这条测试都成立，切换开关不需要改测试。
  it("debug 开关开=明文 IP；关=16 位哈希无明文", async () => {
    const h = await ipHash("1.2.3.4", SECRET);
    if (DEBUG_PLAINTEXT_IP) {
      expect(h).toBe("1.2.3.4");
    } else {
      expect(h).toHaveLength(16);
      expect(h).not.toContain(".");
    }
  });
  it("test owner 不写指纹（测试页不得污染真实访客的归因）", async () => {
    await writeRefhit(env, "1.2.3.4", SECRET, "users/test-og-check/", "TESTOG", NOW - 7200_000);
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-a/", "tokA", NOW - 3600_000);
    const hit = await lookupRefhit(env, "1.2.3.4", SECRET, NOW);
    expect(hit && hit.owner).toBe("users/anon-a/");   // TESTOG 不落盘，不构成多 owner
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
