// test/usage_edit.test.js
// vi.mock is hoisted by vitest before static imports, so this prevents the real
// `agents` package (which imports cloudflare:email / cloudflare:workers) from
// ever being loaded — the same pattern used for any CF-only module in this suite.
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./fakes.js";
import { meteredEditGate } from "../src/index.js";
import { ensureAccount, debit } from "../src/usage_store.js";
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = readFileSync(fileURLToPath(new URL("../migrations/0001_usage.sql", import.meta.url)), "utf8");

describe("meteredEditGate", () => {
  it("ok for funded new user", async () => {
    const db = fakeD1(SQL);
    expect(await meteredEditGate(db, "users/anon-a/", "s1", 1)).toBe("ok");
  });
  it("no-credit when drained", async () => {
    const db = fakeD1(SQL);
    await ensureAccount(db, "users/anon-b/", 1);
    await debit(db, "users/anon-b/", SIGNUP_GRANT_UY, "edit", { stem: "s1" }, 2);
    expect(await meteredEditGate(db, "users/anon-b/", "s1", 3)).toBe("no-credit");
  });
  it("limit at 100 edits of same stem", async () => {
    const db = fakeD1(SQL);
    await ensureAccount(db, "users/anon-c/", 1);
    for (let i = 0; i < 100; i++) await debit(db, "users/anon-c/", 1, "edit", { stem: "s1" }, 10 + i);
    expect(await meteredEditGate(db, "users/anon-c/", "s1", 200)).toBe("limit");
  });
});
