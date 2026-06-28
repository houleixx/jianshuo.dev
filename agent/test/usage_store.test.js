// test/usage_store.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./fakes.js";
import { ensureAccount, getBalanceUY, debit, grant, getLedger, editCount, allAccounts } from "../src/usage_store.js";
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = readFileSync(fileURLToPath(new URL("../migrations/0001_usage.sql", import.meta.url)), "utf8");
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
  it("editCount counts only edit rows for that stem", async () => {
    await ensureAccount(db, U, 1);
    await debit(db, U, 1, "edit", { stem: "a" }, 2);
    await debit(db, U, 1, "edit", { stem: "a" }, 3);
    await debit(db, U, 1, "edit", { stem: "b" }, 4);
    await debit(db, U, 1, "mine", { stem: "a" }, 5);
    expect(await editCount(db, U, "a")).toBe(2);
  });
  it("allAccounts returns rows", async () => {
    await ensureAccount(db, U, 1);
    expect((await allAccounts(db)).length).toBe(1);
  });
});
