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
