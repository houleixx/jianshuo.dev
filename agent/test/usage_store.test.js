// test/usage_store.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { ensureAccount, getBalanceUY, debit, grant, getLedger, editCount, allAccounts } from "../src/usage_store.js";
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = usageSql();
const U = "users/anon-test/";
let db;
beforeEach(() => { db = fakeD1(SQL); });

describe("usage_store", () => {
  it("ensureAccount grants signup once, idempotent", async () => {
    expect(await ensureAccount(db, U, 1)).toBe(SIGNUP_GRANT_UY);
    expect(await ensureAccount(db, U, 2)).toBe(SIGNUP_GRANT_UY); // no double grant
    expect(await getBalanceUY(db, U)).toBe(SIGNUP_GRANT_UY);
    expect((await getLedger(db, U, 10)).length).toBe(1);
  });
  it("debit lowers balance + writes ledger; can overdraw", async () => {
    await ensureAccount(db, U, 1);
    await debit(db, U, SIGNUP_GRANT_UY + 5, "mine", { stem: "s1" }, 2);
    expect(await getBalanceUY(db, U)).toBe(-5);
    const led = await getLedger(db, U, 10);
    expect(led[0].kind).toBe("spend");
    expect(led[0].balance_uy).toBe(-5);
  });
  it("grant adds + ensures account", async () => {
    await grant(db, U, 1000, "campaign:x", 1);
    expect(await getBalanceUY(db, U)).toBe(SIGNUP_GRANT_UY + 1000);
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
  it("concurrent first-touch: no double signup-grant if row exists at spend-down balance", async () => {
    // Simulate: a concurrent caller already created the account (with some spend).
    // ensureAccount must return the actual current balance, not SIGNUP_GRANT_UY,
    // and must NOT insert a second signup ledger row.
    const alreadySpent = 999;
    const currentBal = SIGNUP_GRANT_UY - alreadySpent;
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(U, currentBal, SIGNUP_GRANT_UY, alreadySpent, 1, 1).run();
    db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
      .bind(U, 1, "grant", SIGNUP_GRANT_UY, "signup", null, SIGNUP_GRANT_UY).run();

    const bal = await ensureAccount(db, U, 200);
    expect(bal).toBe(currentBal);                        // existing balance, not SIGNUP_GRANT_UY
    expect((await getLedger(db, U, 10)).length).toBe(1); // still only 1 grant row — no double-grant
  });
});
