// test/usage_mine.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./fakes.js";
import { meteredMineGate } from "../src/miner.js";   // extracted, see Step 3
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = readFileSync(fileURLToPath(new URL("../migrations/0001_usage.sql", import.meta.url)), "utf8");

describe("meteredMineGate", () => {
  it("new user (lazy 500) with normal duration => ok", async () => {
    const db = fakeD1(SQL);
    expect(await meteredMineGate(db, "users/anon-a/", 60, 1)).toBe("ok");
  });
  it("over 3h => too-long (no account touched needed)", async () => {
    const db = fakeD1(SQL);
    expect(await meteredMineGate(db, "users/anon-b/", 3 * 3600 + 1, 1)).toBe("too-long");
  });
  it("drained balance => no-credit", async () => {
    const db = fakeD1(SQL);
    // drain: ensure + debit everything
    const { ensureAccount, debit } = await import("../src/usage_store.js");
    await ensureAccount(db, "users/anon-c/", 1);
    await debit(db, "users/anon-c/", SIGNUP_GRANT_UY, "mine", {}, 2);
    expect(await meteredMineGate(db, "users/anon-c/", 60, 3)).toBe("no-credit");
  });
});
