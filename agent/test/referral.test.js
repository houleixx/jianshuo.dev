// test/referral.test.js — 邀请奖励：常量 + 报价数学 + claim 路由全流程
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql, fakeEnv } from "./fakes.js";
import { REASON_ZH, REFERRAL_DEFAULTS, POOL_7D_UY, SEED_COINS_UC, DAILY_POOL_UY, FUSE_MULT, DAY_MS } from "../src/usage.js";
import { handleReferralRoutes, referralQuote } from "../src/referral.js";
import { writeRefhit } from "../../functions/lib/refhits.js";
import { hmacSign, b64url } from "../../functions/lib/auth.js";
import { balanceUY, getLedger, ensureAccount } from "../src/usage_store.js";

const SECRET = "test-secret";
async function makeToken(scope, opts = true) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const payload = typeof opts === "boolean" ? { scope, apple: opts } : { scope, ...opts };
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

// 合法 P-256 pkcs8 测试私钥（DeviceCheck JWT 本地签名用）
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const OWNER = "users/anon-owner111/";
const NEWBIE = "users/anon-newbie22/";
const SHARE = "AbCdEf1234";          // shares/<id> 短链（10 位）
const COMM = "shareaaaaaa1";         // 社区 shareId（12 位）
const ART = `${OWNER}articles/a1.json`;

// DeviceCheck fetcher：默认「从未置位 + mark 成功」
const dcFresh = async (url, init) => {
  if (String(url).includes("query_two_bits")) return new Response("Failed to find bit state", { status: 200 });
  return new Response("", { status: 200 });
};
const dcUsed = async (url) => {
  if (String(url).includes("query_two_bits")) return Response.json({ bit0: true, bit1: false });
  return new Response("", { status: 200 });
};

function claimReq(token, body, ip = "9.9.9.9") {
  return new Request("https://jianshuo.dev/agent/referral/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}
const URL_CLAIM = new URL("https://jianshuo.dev/agent/referral/claim");

// 手插 mint 行（模拟历史邀请/投币，喂日封顶与保险丝）
function insertMint(db, { kind = "referral", subject = "x", actor = "someone", benef = OWNER, coinsUC = 0, actorUY = 0, benefUY = 0, ts }) {
  db.prepare(
    "INSERT INTO mint (kind,subject_key,actor_sub,beneficiary_sub,coins_uc,price_uy,actor_uy,beneficiary_uy,ts) VALUES (?,?,?,?,?,1,?,?,?)"
  ).bind(kind, subject, actor, benef, coinsUC, actorUY, benefUY, ts).run();
}

let db, env, newbieTok;
beforeEach(async () => {
  db = fakeD1(usageSql());
  env = fakeEnv({
    [`shares/${SHARE}`]: ART,
    [`community/${COMM}.json`]: JSON.stringify({ schema: 2, shareId: COMM, owner: OWNER, articleKey: ART }),
    [ART]: JSON.stringify({ articles: [{ title: "t1", body: "b" }] }),
  });
  env.USAGE = db;
  env.SESSION_SECRET = SECRET;
  env.APNS_KEY_P8 = TEST_P8;
  env.APNS_KEY_ID = "KEYID12345";
  env.APNS_TEAM_ID = "97XBW2A43H";
  newbieTok = await makeToken(NEWBIE, false);
});

async function claim(body, { token = newbieTok, ip = "9.9.9.9", dc = dcFresh } = {}) {
  const resp = await handleReferralRoutes(URL_CLAIM, claimReq(token, body, ip), env, dc);
  return { status: resp.status, json: await resp.json() };
}

describe("referral constants", () => {
  it("has Chinese ledger names", () => {
    expect(REASON_ZH["referral_author"]).toBe("邀请奖励");
    expect(REASON_ZH["referral_new"]).toBe("受邀赠送");
  });
  it("has defaults", () => {
    expect(REFERRAL_DEFAULTS).toEqual({
      enabled: true, authorCoins: 12, newUserCoins: 6,
      dailyCapPerOwner: 30, requireDeviceCheck: true,
    });
  });
});

describe("referralQuote", () => {
  it("cold-start math: denom = seed + 本次", () => {
    const q = referralQuote(0, 12e6, 6e6);
    const denom = SEED_COINS_UC + 18e6;
    expect(q.denomUC).toBe(denom);
    expect(q.beneficiaryUY).toBe(Math.floor((12e6 * POOL_7D_UY) / denom));
    expect(q.actorUY).toBe(Math.floor((6e6 * POOL_7D_UY) / denom));
    expect(q.priceUY).toBe(Math.floor(POOL_7D_UY / (denom / 1e6)));
  });
  it("more minted 7d → lower payout", () => {
    const cold = referralQuote(0, 12e6, 6e6);
    const hot = referralQuote(500e6, 12e6, 6e6);
    expect(hot.beneficiaryUY).toBeLessThan(cold.beneficiaryUY);
  });
});

describe("claim — link token", () => {
  it("pays both sides, writes mint + ledgers + rate file", async () => {
    const now = Date.now();
    await ensureAccount(db, NEWBIE, now - 3600_000); // 出生 1h 前 → 新
    const ownerBefore = await balanceUY(db, OWNER, now);
    const newbieBefore = await balanceUY(db, NEWBIE, now);

    const { status, json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(status).toBe(200);
    expect(json.attributed).toBe(true);
    expect(json.suanli.you).toBeGreaterThan(0);
    expect(json.suanli.author).toBeGreaterThan(0);

    expect(await balanceUY(db, OWNER, now)).toBeGreaterThan(ownerBefore);
    expect(await balanceUY(db, NEWBIE, now)).toBeGreaterThan(newbieBefore);
    const ownerLed = await getLedger(db, OWNER);
    expect(ownerLed.some((l) => l.reason === "referral_author")).toBe(true);
    const newbieLed = await getLedger(db, NEWBIE);
    expect(newbieLed.some((l) => l.reason === "referral_new")).toBe(true);
    // mint 行
    const row = db.prepare("SELECT * FROM mint WHERE kind='referral'").first();
    expect(row.subject_key).toBe(NEWBIE);
    expect(row.beneficiary_sub).toBe(OWNER);
    expect(row.coins_uc).toBe(18e6);
    // 90 天过期桶
    const bucket = db.prepare(
      "SELECT expires_at, created_at FROM bucket WHERE user_sub=? AND source='referral_author'").bind(OWNER).first();
    expect(bucket.expires_at - bucket.created_at).toBe(90 * DAY_MS);
    // 汇率文件
    const rate = JSON.parse(await (await env.FILES.get("config/mint-rate.json")).text());
    expect(rate.suanliPerCoin).toBeGreaterThan(0);
  });

  it("idempotent: second claim → already, no double pay", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    const balAfter1 = await balanceUY(db, OWNER, Date.now());
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: true, already: true });
    expect(await balanceUY(db, OWNER, Date.now())).toBe(balAfter1);
  });

  it("community shareId token also resolves owner", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "clipboard", token: COMM, deviceCheckToken: "dt" });
    expect(json.attributed).toBe(true);
    const row = db.prepare("SELECT beneficiary_sub FROM mint WHERE kind='referral'").first();
    expect(row.beneficiary_sub).toBe(OWNER);
  });

  it("rejects account older than 24h", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 25 * 3600_000);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: false, reason: "not-new" });
  });

  it("rejects self-referral", async () => {
    const ownerTok = await makeToken(OWNER, false);
    await ensureAccount(db, OWNER, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" }, { token: ownerTok });
    expect(json).toEqual({ attributed: false, reason: "self" });
  });

  it("unknown token → no-match (no refhit either)", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: "ZZnope99", deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: false, reason: "no-match" });
  });
});

describe("claim — hello (IP)", () => {
  it("unique refhit owner attributes silently", async () => {
    const now = Date.now();
    await ensureAccount(db, NEWBIE, now - 3600_000);
    await writeRefhit(env, "9.9.9.9", SECRET, OWNER, SHARE, now - 1800_000);
    const { json } = await claim({ source: "hello", deviceCheckToken: "dt" });
    expect(json.attributed).toBe(true);
    const row = db.prepare("SELECT detail FROM mint WHERE kind='referral'").first();
    expect(JSON.parse(row.detail).via).toBe("hello");
  });
  it("two owners on same ip → no-match", async () => {
    const now = Date.now();
    await ensureAccount(db, NEWBIE, now - 3600_000);
    await writeRefhit(env, "9.9.9.9", SECRET, OWNER, SHARE, now - 1800_000);
    await writeRefhit(env, "9.9.9.9", SECRET, "users/anon-other33/", "xTok", now - 900_000);
    const { json } = await claim({ source: "hello", deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: false, reason: "no-match" });
  });
});

describe("claim — DeviceCheck", () => {
  it("bit0 already set → device-used, no pay", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" }, { dc: dcUsed });
    expect(json).toEqual({ attributed: false, reason: "device-used" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mint").first().n).toBe(0);
  });
  it("no dc token while required → device-unavailable", async () => {
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE });
    expect(json).toEqual({ attributed: false, reason: "device-unavailable" });
  });
  it("requireDeviceCheck:false lets simulator through", async () => {
    await env.FILES.put("config/referral.json", JSON.stringify({ requireDeviceCheck: false }));
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE });
    expect(json.attributed).toBe(true);
  });
});

describe("claim — caps & fuse", () => {
  it("owner daily cap: newbie still paid, owner gets 0", async () => {
    const now = Date.now();
    const day0 = now - (now % DAY_MS);
    for (let i = 0; i < 30; i++)
      insertMint(db, { subject: `users/anon-old${i}/`, actor: `users/anon-old${i}/`, ts: day0 + 1000 + i });
    await ensureAccount(db, NEWBIE, now - 3600_000);
    const ownerBefore = await balanceUY(db, OWNER, now);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(json.attributed).toBe(true);
    expect(json.suanli.you).toBeGreaterThan(0);
    expect(json.suanli.author).toBe(0);
    expect(await balanceUY(db, OWNER, now)).toBe(ownerBefore);
    expect((await getLedger(db, OWNER)).some((l) => l.reason === "referral_author")).toBe(false);
  });

  it("daily fuse blown → pool_exhausted", async () => {
    const now = Date.now();
    const day0 = now - (now % DAY_MS);
    insertMint(db, { kind: "feed", subject: "k", benef: "users/anon-x/", actorUY: FUSE_MULT * DAILY_POOL_UY + 1, benefUY: 0, ts: day0 + 1000 });
    await ensureAccount(db, NEWBIE, now - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: false, reason: "pool_exhausted" });
  });

  it("disabled via config", async () => {
    await env.FILES.put("config/referral.json", JSON.stringify({ enabled: false }));
    await ensureAccount(db, NEWBIE, Date.now() - 3600_000);
    const { json } = await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    expect(json).toEqual({ attributed: false, reason: "disabled" });
  });

  it("referral mints enter the shared 7d denominator (next quote cheaper)", async () => {
    const now = Date.now();
    await ensureAccount(db, NEWBIE, now - 3600_000);
    await claim({ source: "link", token: SHARE, deviceCheckToken: "dt" });
    const sum = db.prepare("SELECT COALESCE(SUM(coins_uc),0) AS s FROM mint WHERE ts>?").bind(now - 7 * DAY_MS).first().s;
    expect(sum).toBe(18e6); // 投币的 sumCoins7d 同一查询口径，无 kind 过滤
  });
});

describe("claim — auth", () => {
  it("no token → 401", async () => {
    const resp = await handleReferralRoutes(URL_CLAIM,
      new Request("https://jianshuo.dev/agent/referral/claim", { method: "POST", body: "{}" }), env, dcFresh);
    expect(resp.status).toBe(401);
  });
  it("non-claim path → null (passthrough)", async () => {
    const r = await handleReferralRoutes(new URL("https://jianshuo.dev/agent/other"),
      claimReq(newbieTok, {}), env, dcFresh);
    expect(r).toBeNull();
  });
});
