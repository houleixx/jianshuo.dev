// GET /agent/prompt-market — 提示词市场列表（2026-07-22 提示词退出社区 feed 后的
// 唯一公共曝光端）。数据源：D1 prompt_shares + share_stats + R2 shares/<code> 写穿副本。
import { describe, it, expect } from "vitest";
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import { handlePromptMarket } from "../src/prompt-market.js";
import { coreUpsertPromptShare, coreSeedImportCount } from "../../functions/lib/core-db.js";

const TOK = "anon_market-test-1234567890";
const doc = (label, appliesTo, importCount = 0) =>
  JSON.stringify({ type: "prompt", sub: "abc", itemId: "p_1", label, instruction: "内容", appliesTo, importCount });

async function makeEnv(seed = {}) {
  const e = { ...fakeEnv(seed), CORE: fakeD1(coreSql()) };
  return e;
}
const GET = (env, qs = "") => {
  const req = new Request(`https://jianshuo.dev/agent/prompt-market${qs}`, {
    headers: { Authorization: `Bearer ${TOK}` },
  });
  return handlePromptMarket(new URL(req.url), req, env);
};

describe("GET /agent/prompt-market", () => {
  it("无 token → 401；非本路由 → null 放行", async () => {
    const env = await makeEnv();
    const req = new Request("https://jianshuo.dev/agent/prompt-market");
    expect((await handlePromptMarket(new URL(req.url), req, env)).status).toBe(401);
    const other = new Request("https://jianshuo.dev/agent/other");
    expect(await handlePromptMarket(new URL(other.url), other, env)).toBeNull();
  });

  it("只列活码（shares/<code> 在）；已关闭的不出现", async () => {
    const env = await makeEnv({ "shares/1111111": doc("活的", ["text"]) });
    await coreUpsertPromptShare(env, "users/anon-a/", "p_1", "1111111", "2026-07-20T00:00:00.000Z");
    await coreUpsertPromptShare(env, "users/anon-a/", "p_2", "2222222", "2026-07-21T00:00:00.000Z"); // 无 R2 副本=已关
    const r = await GET(env);
    const { items } = await r.json();
    expect(items.length).toBe(1);
    expect(items[0].code).toBe("1111111");
    expect(items[0].label).toBe("活的");
  });

  it("hot 排序：导入多的老码 vs 零导入新码（时间衰减公式生效）；new 按时间", async () => {
    const env = await makeEnv({
      "shares/1111111": doc("导入王", ["text"], 50),
      "shares/2222222": doc("新来的", ["text"], 0),
    });
    // 老码写「10 天前」而非固定日期——hotScore 随今天衰减，写死日期的话 ageDays
    // 越跑越大，50 次导入迟早被新码的新鲜度压过（2026-08-03 真栽过）。
    await coreUpsertPromptShare(env, "users/anon-a/", "p_1", "1111111", new Date(Date.now() - 10 * 86400e3).toISOString());
    await coreUpsertPromptShare(env, "users/anon-b/", "p_2", "2222222", new Date().toISOString());
    await coreSeedImportCount(env, "1111111", 50);
    const hot = (await (await GET(env, "?sort=hot")).json()).items;
    expect(hot[0].code).toBe("1111111");            // 50 次导入压过新鲜度
    const newest = (await (await GET(env, "?sort=new")).json()).items;
    expect(newest[0].code).toBe("2222222");
  });

  it("scope=image 过滤：仅文字项不出现；缺 appliesTo 的老副本当「都行」", async () => {
    const env = await makeEnv({
      "shares/1111111": doc("仅文字", ["text"]),
      "shares/2222222": doc("仅图片", ["image"]),
      "shares/3333333": JSON.stringify({ type: "prompt", sub: "x", itemId: "p", label: "老副本", instruction: "i" }),
    });
    for (const [i, c] of ["1111111", "2222222", "3333333"].entries())
      await coreUpsertPromptShare(env, `users/anon-${i}/`, `p_${i}`, c, "2026-07-20T00:00:00.000Z");
    const items = (await (await GET(env, "?scope=image")).json()).items;
    const codes = items.map((x) => x.code).sort();
    expect(codes).toEqual(["2222222", "3333333"]);  // 仅图片 + 都行；仅文字被滤
  });
});

// ── 物化缓存（2026-07-23 提速）───────────────────────────────────────────────
import { invalidateMarketCache } from "../src/prompt-market.js";

describe("materialized cache", () => {
  const CACHE_KEY = "market/prompt-market-cache.json";
  async function seededEnv() {
    const env = await makeEnv({ "shares/1111111": doc("活的", ["text"]) });
    await coreUpsertPromptShare(env, "users/anon-a/", "p_1", "1111111", "2026-07-20T00:00:00.000Z");
    return env;
  }

  it("首次现算后写缓存；第二次请求命中缓存（不再读 shares/）", async () => {
    const env = await seededEnv();
    await GET(env);                                       // 内联现算 + 写缓存
    expect(env.FILES._store.has(CACHE_KEY)).toBe(true);
    const reads = [];
    const rawGet = env.FILES.get.bind(env.FILES);
    env.FILES.get = async (k) => { reads.push(String(k)); return rawGet(k); };
    const r = await GET(env);
    expect(r.status).toBe(200);
    expect((await r.json()).items.length).toBeGreaterThan(0);
    expect(reads.filter((k) => k.startsWith("shares/"))).toHaveLength(0); // 只读缓存
  });

  it("缓存过期 + 有 ctx → 先回旧数据，后台重建（waitUntil）", async () => {
    const env = await seededEnv();
    await GET(env);
    const doc = JSON.parse(env.FILES._store.get(CACHE_KEY));
    doc.builtAt = Date.now() - 10 * 60 * 1000;            // 人为过期
    env.FILES._store.set(CACHE_KEY, JSON.stringify(doc));
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const req = new Request("https://jianshuo.dev/agent/prompt-market", { headers: { Authorization: `Bearer ${TOK}` } });
    const r = await handlePromptMarket(new URL(req.url), req, env, ctx);
    expect(r.status).toBe(200);                            // 立即响应（旧数据）
    expect(waited).toHaveLength(1);
    await Promise.all(waited);                             // 后台重建完成
    expect(JSON.parse(env.FILES._store.get(CACHE_KEY)).builtAt).toBeGreaterThan(doc.builtAt);
  });

  it("invalidateMarketCache 删缓存对象", async () => {
    const env = await seededEnv();
    await GET(env);
    expect(env.FILES._store.has(CACHE_KEY)).toBe(true);
    await invalidateMarketCache(env);
    expect(env.FILES._store.has(CACHE_KEY)).toBe(false);
  });
});
