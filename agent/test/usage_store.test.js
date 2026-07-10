// test/usage_store.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { ensureAccount, debit, getLedger, editCount, allAccounts, balanceUY, grantBucket } from "../src/usage_store.js";
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = usageSql();
const U = "users/anon-test/";
let db;
beforeEach(() => { db = fakeD1(SQL); });

describe("usage_store", () => {
  it("ensureAccount grants signup once into a 1y bucket, idempotent", async () => {
    expect(await ensureAccount(db, U, 1)).toBe(SIGNUP_GRANT_UY);
    expect(await ensureAccount(db, U, 2)).toBe(SIGNUP_GRANT_UY); // 不二次发放
    expect(await balanceUY(db, U, 2)).toBe(SIGNUP_GRANT_UY);
    const buckets = db.prepare("SELECT source,expires_at,remaining_uy FROM bucket WHERE user_sub=?").bind(U).all().results;
    expect(buckets.length).toBe(1);
    expect(buckets[0].source).toBe("signup");
    expect(buckets[0].expires_at).toBe(1 + 365 * 86400000); // 按首次 now=1 盖 1 年
    expect((await getLedger(db, U, 10)).length).toBe(1);
  });
  it("debit lowers balance + writes ledger; can overdraw", async () => {
    await ensureAccount(db, U, 1);
    await debit(db, U, SIGNUP_GRANT_UY + 5, "mine", { stem: "s1" }, 2);
    expect(await balanceUY(db, U, 2)).toBe(-5);
    const led = await getLedger(db, U, 10);
    expect(led[0].kind).toBe("spend");
    expect(led[0].balance_uy).toBe(-5);
  });
  it("grantBucket on a fresh user also triggers signup, then adds", async () => {
    await grantBucket(db, U, 1000, "campaign:x", null, 1);
    expect(await balanceUY(db, U, 1)).toBe(SIGNUP_GRANT_UY + 1000);
  });
  it("editCount counts distinct turns (real edits), not API call rows", async () => {
    await ensureAccount(db, U, 1);
    // One edit = 2 API calls sharing turn_id "t1" (should count as 1)
    await debit(db, U, 1, "edit", { stem: "a", turn_id: "t1" }, 2);
    await debit(db, U, 1, "edit", { stem: "a", turn_id: "t1" }, 3);
    // Second distinct edit turn_id "t2" (counts as 1 more)
    await debit(db, U, 1, "edit", { stem: "a", turn_id: "t2" }, 4);
    // Different stem — must NOT count for stem "a"
    await debit(db, U, 1, "edit", { stem: "b", turn_id: "t3" }, 5);
    // Different reason — must NOT count
    await debit(db, U, 1, "mine", { stem: "a", turn_id: "t4" }, 6);
    // Expect 2 distinct turns for stem "a" (NOT 3 rows)
    expect(await editCount(db, U, "a")).toBe(2);
  });
  it("allAccounts returns rows", async () => {
    await ensureAccount(db, U, 1);
    expect((await allAccounts(db)).length).toBe(1);
  });
  it("concurrent first-touch: existing account+bucket → no second signup", async () => {
    const alreadySpent = 999;
    const currentBal = SIGNUP_GRANT_UY - alreadySpent;
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(U, currentBal, SIGNUP_GRANT_UY, alreadySpent, 1, 1).run();
    db.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(U, SIGNUP_GRANT_UY, currentBal, "signup", 1, null).run();

    const bal = await ensureAccount(db, U, 200);
    expect(bal).toBe(currentBal);
    const n = db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE user_sub=?").bind(U).first().n;
    expect(n).toBe(1); // 没有第二个 signup 桶
  });
});

describe("debit draws soonest-expiry first", () => {
  // Seed buckets directly (bypass grantBucket/ensureAccount) so these tests
  // isolate debit's draining order without a signup bucket in the mix.
  const seed = (amount, source, expiresAt) =>
    db.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(U, amount, amount, source, 1, expiresAt).run();

  it("spends the sooner-expiring bucket before the later/never one", async () => {
    seed(100, "campaign:soon", 5000);   // 先过期
    seed(100, "campaign:never", null);  // 永不过期
    await debit(db, U, 120, "mine", { stem: "s" }, 2);
    const rows = db.prepare("SELECT source,remaining_uy FROM bucket WHERE user_sub=? ORDER BY id").bind(U).all().results;
    const soon = rows.find((r) => r.source === "campaign:soon");
    const never = rows.find((r) => r.source === "campaign:never");
    expect(soon.remaining_uy).toBe(0);    // 先扣光
    expect(never.remaining_uy).toBe(80);  // 再扣 20
  });
  it("skips expired buckets entirely", async () => {
    seed(100, "campaign:dead", 5000);   // now>5000 时已过期
    seed(100, "campaign:live", null);
    await debit(db, U, 30, "mine", { stem: "s" }, 6000);
    const live = db.prepare("SELECT remaining_uy FROM bucket WHERE user_sub=? AND source='campaign:live'").bind(U).first();
    const dead = db.prepare("SELECT remaining_uy FROM bucket WHERE user_sub=? AND source='campaign:dead'").bind(U).first();
    expect(live.remaining_uy).toBe(70);   // 只从活桶扣
    expect(dead.remaining_uy).toBe(100);  // 过期桶不动
    expect(await balanceUY(db, U, 6000)).toBe(70);
  });
  it("overdraft drives the last live bucket negative", async () => {
    seed(50, "campaign:x", null);
    await debit(db, U, 70, "mine", { stem: "s" }, 2);
    const row = db.prepare("SELECT remaining_uy FROM bucket WHERE user_sub=? AND source='campaign:x'").bind(U).first();
    expect(row.remaining_uy).toBe(-20);
    expect(await balanceUY(db, U, 2)).toBe(-20);
  });
  it("inserts an overdraft bucket when there are no live buckets", async () => {
    seed(100, "campaign:expired", 1000);     // expires before now=2000
    await debit(db, U, 40, "mine", null, 2000);
    const od = db.prepare(
      "SELECT remaining_uy, expires_at FROM bucket WHERE user_sub=? AND source='overdraft'"
    ).bind(U).first();
    expect(od.remaining_uy).toBe(-40);
    expect(od.expires_at).toBeNull();
    expect(await balanceUY(db, U, 2000)).toBe(-40);
  });
});

describe("buckets", () => {
  it("balanceUY sums only live buckets", async () => {
    await grantBucket(db, U, 1000, "campaign:x", 5000, 1);   // 过期=5000
    await grantBucket(db, U, 2000, "campaign:y", null, 1);   // 永不过期
    // grantBucket 首次调用触发 ensureAccount，会额外写一个 1y signup 桶（SIGNUP_GRANT_UY）
    expect(await balanceUY(db, U, 1)).toBe(SIGNUP_GRANT_UY + 3000);    // signup + 两个 campaign 都活
    expect(await balanceUY(db, U, 6000)).toBe(SIGNUP_GRANT_UY + 2000); // campaign:x 过期；signup 仍活
  });
  it("grantBucket bumps granted_uy and writes a grant ledger row", async () => {
    await grantBucket(db, U, 1000, "campaign:x", null, 1);
    const led = await getLedger(db, U, 10);
    expect(led[0].kind).toBe("grant");
    expect(led[0].amount_uy).toBe(1000);
    expect(led[0].reason).toBe("campaign:x");
  });
});

// ── 翻页 + 全量聚合（算力页修复：老账单看不到、来源只算部分窗口）──────────────
import { usageSummary } from "../src/usage_store.js";

describe("getLedger pagination + usageSummary", () => {
  it("getLedger 游标翻页：不重不漏走完全部历史（含同毫秒多笔）", async () => {
    db = fakeD1(SQL);
    await ensureAccount(db, U, 1);
    for (let i = 0; i < 7; i++) await debit(db, U, 10, "mine", null, 100 + i);
    await debit(db, U, 5, "asr", null, 200);   // 同一毫秒两笔——必须靠 id 区分
    await debit(db, U, 5, "asr", null, 200);
    const seen = [];
    let before = null;
    for (;;) {
      const page = await getLedger(db, U, 3, before);
      if (!page.length) break;
      seen.push(...page.map((r) => r.id));
      before = { ts: page[page.length - 1].ts, id: page[page.length - 1].id };
      if (page.length < 3) break;
    }
    expect(seen.length).toBe(10);              // signup + 7 + 2
    expect(new Set(seen).size).toBe(10);       // 无重复
  });
  it("usageSummary 全量按 kind+reason 聚合，不受任何条数窗口限制", async () => {
    db = fakeD1(SQL);
    await ensureAccount(db, U, 1);
    await grantBucket(db, U, 1000, "feed_author", null, 2);
    await debit(db, U, 100, "mine", null, 3);
    await debit(db, U, 50, "mine", null, 4);
    await debit(db, U, 30, "asr", null, 5);
    const rows = await usageSummary(db, U);
    const find = (k, r) => rows.find((x) => x.kind === k && x.reason === r);
    expect(find("grant", "signup").total_uy).toBe(SIGNUP_GRANT_UY);
    expect(find("grant", "feed_author").total_uy).toBe(1000);
    expect(find("spend", "mine").total_uy).toBe(150);
    expect(find("spend", "mine").n).toBe(2);
    expect(find("spend", "asr").total_uy).toBe(30);
  });
});
