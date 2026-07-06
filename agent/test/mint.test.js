// test/mint.test.js — 投币接口 + 铸币价格数学
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql, fakeEnv } from "./fakes.js";
import { handleMintRoutes, feedQuote } from "../src/mint.js";
import { hmacSign, b64url } from "../../functions/lib/auth.js";
import { balanceUY, getLedger } from "../src/usage_store.js";
import {
  SIGNUP_GRANT_UY, DAILY_POOL_UY, FUSE_MULT, POOL_7D_UY, SEED_COINS_UC,
  uyToSuanli,
} from "../src/usage.js";

const SECRET = "test-secret";
async function makeToken(scope, apple = true) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, apple }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

const AUTHOR = "users/anon-author11/";
const FEEDER = "users/anon-feeder22/";
const SHARE1 = "shareaaaaaa1";
const SHARE2 = "shareaaaaaa2";
const ART1 = `${AUTHOR}articles/a1.json`;
const ART2 = `${AUTHOR}articles/a2.json`;

let db, env;
beforeEach(() => {
  db = fakeD1(usageSql());
  env = fakeEnv({
    [`community/${SHARE1}.json`]: JSON.stringify({ schema: 2, shareId: SHARE1, owner: AUTHOR, articleKey: ART1 }),
    [`community/${SHARE2}.json`]: JSON.stringify({ schema: 2, shareId: SHARE2, owner: AUTHOR, articleKey: ART2 }),
    [ART1]: JSON.stringify({ articles: [{ title: "t1", body: "b" }] }),
    [ART2]: JSON.stringify({ articles: [{ title: "t2", body: "b" }] }),
  });
  env.USAGE = db;
  env.SESSION_SECRET = SECRET;
});

const post = (path, token, body) => handleMintRoutes(
  new URL(`https://jianshuo.dev${path}`),
  new Request(`https://jianshuo.dev${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }),
  env,
);

// ── feedQuote 纯数学 ─────────────────────────────────────────────────────────
describe("feedQuote", () => {
  it("冷启动：70 币底座封顶价格，首笔作者约 386 算力", () => {
    const q = feedQuote(0, 0);
    // 价格 ≤ 200 算力/币（底座封顶），本例 14000/72.5 ≈ 193
    expect(uyToSuanli(q.priceUY)).toBeLessThanOrEqual(200);
    expect(Math.round(uyToSuanli(q.priceUY))).toBe(193);
    expect(Math.round(uyToSuanli(q.beneficiaryUY))).toBe(386); // 2 币
    expect(Math.round(uyToSuanli(q.actorUY))).toBe(97);        // 0.5 币
  });
  it("活跃度越高价格越低（分母增长）", () => {
    const cold = feedQuote(0, 0);
    const busy = feedQuote(1000e6, 0); // 7 天已铸 1000 币
    expect(busy.priceUY).toBeLessThan(cold.priceUY / 10);
  });
  it("同对递减：第2次×0.7，第3次起×0.5", () => {
    expect(feedQuote(0, 0).disc).toBe(1);
    expect(feedQuote(0, 1).disc).toBe(0.7);
    expect(feedQuote(0, 2).disc).toBe(0.5);
    expect(feedQuote(0, 9).disc).toBe(0.5);
    expect(feedQuote(0, 1).authorUC).toBe(1.4e6); // 2 币 × 0.7，微金币精确
    expect(feedQuote(0, 1).feederUC).toBe(0.35e6);
  });
  it("单日全额投喂约等于日池（守恒 sanity）", () => {
    // 若 7 天恰好铸出「底座外」x 币使 payout 总额 ≈ 池子：数学上
    // Σpayout = Σcoins×POOL/(SEED+sum) < POOL —— 永不超过池子总额（含底座沉淀）。
    const q = feedQuote(SEED_COINS_UC * 100, 0); // 极端高活跃
    expect(q.beneficiaryUY + q.actorUY).toBeLessThan(POOL_7D_UY);
  });
});

// ── POST /agent/feed ─────────────────────────────────────────────────────────
describe("POST /agent/feed", () => {
  it("投币成功：双边即时到账 + ledger 带 feed_id + mint 行落库", async () => {
    const r = await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.coins).toEqual({ author: 2, feeder: 0.5 });
    expect(j.suanli.author).toBeCloseTo(386.2, 0);

    const row = db.prepare("SELECT * FROM mint").bind().first();
    expect(row.kind).toBe("feed");
    expect(row.subject_key).toBe(ART1);
    expect(row.actor_sub).toBe(FEEDER);
    expect(row.beneficiary_sub).toBe(AUTHOR);
    expect(row.coins_uc).toBe(2.5e6);
    expect(row.beneficiary_uy + row.actor_uy).toBeGreaterThan(0);

    const now = Date.now();
    expect(await balanceUY(db, AUTHOR, now)).toBe(SIGNUP_GRANT_UY + row.beneficiary_uy);
    expect(await balanceUY(db, FEEDER, now)).toBe(SIGNUP_GRANT_UY + row.actor_uy);
    const led = await getLedger(db, AUTHOR, 10);
    const grant = led.find((e) => e.reason === "feed_author");
    expect(JSON.parse(grant.detail).feed_id).toBe(row.id);
  });

  it("幂等：同一人同一篇第二次投 → already，不重复付款", async () => {
    await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    const bal = await balanceUY(db, AUTHOR, Date.now());
    const r2 = await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    expect((await r2.json()).already).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mint").bind().first().n).toBe(1);
    expect(await balanceUY(db, AUTHOR, Date.now())).toBe(bal);
  });

  it("同对第二篇打七折，响应带 discount", async () => {
    await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    const r = await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE2 });
    const j = await r.json();
    expect(j.discount).toBe(0.7);
    expect(j.coins).toEqual({ author: 1.4, feeder: 0.35 });
  });

  it("不能投自己的文章", async () => {
    const r = await post("/agent/feed", await makeToken(AUTHOR), { share_id: SHARE1 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("cannot_feed_own");
  });

  it("匿名 token → 403 needs_apple_signin；非 Apple session 同样", async () => {
    const r1 = await post("/agent/feed", "anon_0123456789abcdef012345", { share_id: SHARE1 });
    expect(r1.status).toBe(403);
    expect((await r1.json()).error).toBe("needs_apple_signin");
    const r2 = await post("/agent/feed", await makeToken(FEEDER, false), { share_id: SHARE1 });
    expect(r2.status).toBe(403);
  });

  it("share 不存在 → 404；文章已删 → 404", async () => {
    const r1 = await post("/agent/feed", await makeToken(FEEDER), { share_id: "nonexistent1" });
    expect(r1.status).toBe(404);
    env.FILES._store.delete(ART1);
    const r2 = await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    expect(r2.status).toBe(404);
  });

  it("保险丝：当日已发放超 5×日池 → 503 暂停", async () => {
    db.prepare(
      "INSERT INTO mint (kind,subject_key,actor_sub,beneficiary_sub,coins_uc,price_uy,actor_uy,beneficiary_uy,ts) VALUES ('feed','x','y','z',1,1,?,0,?)"
    ).bind(FUSE_MULT * DAILY_POOL_UY + 1, Date.now()).run();
    const r = await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("pool_exhausted");
  });
});

// ── POST /agent/feed/state ───────────────────────────────────────────────────
describe("POST /agent/feed/state", () => {
  it("批量返回计数 + 本人点亮态 + 当前币价", async () => {
    await post("/agent/feed", await makeToken(FEEDER), { share_id: SHARE1 });
    const r = await post("/agent/feed/state", await makeToken(FEEDER), { share_ids: [SHARE1, SHARE2] });
    const j = await r.json();
    expect(j.states[SHARE1]).toEqual({ count: 1, fed: true });
    expect(j.states[SHARE2]).toEqual({ count: 0, fed: false });
    expect(j.price_suanli_per_coin).toBeGreaterThan(0);
    // 别人看同一篇：count 1 但 fed false
    const r2 = await post("/agent/feed/state", await makeToken(AUTHOR), { share_ids: [SHARE1] });
    expect((await r2.json()).states[SHARE1]).toEqual({ count: 1, fed: false });
  });

  it("匿名 token 可查状态（同一用户 anon/Apple scope 一致）", async () => {
    const r = await post("/agent/feed/state", "anon_0123456789abcdef012345", { share_ids: [SHARE1] });
    expect(r.status).toBe(200);
    expect((await r.json()).states[SHARE1]).toEqual({ count: 0, fed: false });
  });
});
