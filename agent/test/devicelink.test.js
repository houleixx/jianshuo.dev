import { describe, it, expect } from "vitest";
import { genDistinctCodes, buildBroadcastMessage, CODE_TTL_MS, MAX_ATTEMPTS, MAX_MATCH, resolveMatchingScopes } from "../src/devicelink.js";
import { fakeEnv } from "./fakes.js";

describe("constants", () => {
  it("are the agreed protocol values", () => {
    expect(CODE_TTL_MS).toBe(120000);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(MAX_MATCH).toBe(10);
  });
});

describe("genDistinctCodes", () => {
  it("returns n distinct 4-digit zero-padded codes even when the rng collides", () => {
    // rng yields: 7,7,7,42 -> must skip the dup 7s and still produce 2 distinct
    const seq = [7, 7, 7, 42];
    let i = 0;
    const codes = genDistinctCodes(2, () => seq[i++]);
    expect(codes).toEqual(["0007", "0042"]);
    expect(new Set(codes).size).toBe(2);
  });
});

describe("buildBroadcastMessage", () => {
  it("passes an explicit payload through verbatim", () => {
    const p = { type: "link_request", pairingId: "x", code: "0001", pubkey: "k" };
    expect(buildBroadcastMessage({ payload: p })).toEqual(p);
  });
  it("falls back to the legacy status_update shape (back-compat)", () => {
    expect(buildBroadcastMessage({ stem: "s1", status: "ready" }))
      .toEqual({ type: "status_update", stem: "s1", status: "ready" });
  });
});

describe("resolveMatchingScopes", () => {
  const H1 = "7f3a9c" + "0".repeat(26); // two distinct 32-hex hashes sharing prefix 7f3a9c
  const H2 = "7f3a9c" + "1".repeat(26);
  const OTHER = "abcdef" + "0".repeat(26);

  it("dedups to distinct user scopes that share the 6-hex prefix", async () => {
    const env = fakeEnv({
      [`users/anon-${H1}/articles/a.json`]: "{}",
      [`users/anon-${H1}/VoiceDrop-x.m4a`]: "{}",
      [`users/anon-${H2}/articles/b.json`]: "{}",
      [`users/anon-${OTHER}/articles/c.json`]: "{}",
    });
    const scopes = await resolveMatchingScopes(env, "7F3A9C"); // case-insensitive
    expect(scopes.sort()).toEqual([`users/anon-${H1}/`, `users/anon-${H2}/`]);
  });

  it("returns [] for a malformed prefix", async () => {
    expect(await resolveMatchingScopes(fakeEnv(), "xyz")).toEqual([]);
    expect(await resolveMatchingScopes(fakeEnv(), "7f3a9")).toEqual([]);
  });

  it("returns [] when nothing matches", async () => {
    const env = fakeEnv({ [`users/anon-${OTHER}/articles/c.json`]: "{}" });
    expect(await resolveMatchingScopes(env, "7f3a9c")).toEqual([]);
  });
});

import { createPairing, verifyPairing, completePairing, isExpired } from "../src/devicelink.js";

const ENTRIES = [{ scope: "users/anon-aaa/", code: "1234" }, { scope: "users/anon-bbb/", code: "5678" }];
function fresh(now = 1000) { return createPairing({ pubkey: "PK", entries: ENTRIES, now }); }

describe("createPairing", () => {
  it("starts pending with zero attempts and the agreed ttl", () => {
    const s = fresh();
    expect(s.status).toBe("pending");
    expect(s.attempts).toBe(0);
    expect(s.ttlMs).toBe(120000);
    expect(s.releasingScope).toBe(null);
    expect(s.blob).toBe(null);
  });
});

describe("verifyPairing", () => {
  it("wrong code decrements remaining, stays pending", () => {
    const { state, result } = verifyPairing(fresh(), "0000", 2000);
    expect(result).toEqual({ ok: false, remaining: 4, dead: false });
    expect(state.status).toBe("pending");
    expect(state.attempts).toBe(1);
  });

  it("correct code -> verified + releasingScope = that entry's scope", () => {
    const { state, result } = verifyPairing(fresh(), "5678", 2000);
    expect(result).toEqual({ ok: true, scope: "users/anon-bbb/" });
    expect(state.status).toBe("verified");
    expect(state.releasingScope).toBe("users/anon-bbb/");
  });

  it("dies after MAX_ATTEMPTS wrong tries", () => {
    let s = fresh();
    let r;
    for (let i = 0; i < 5; i++) ({ state: s, result: r } = verifyPairing(s, "0000", 2000));
    expect(r.dead).toBe(true);
    expect(s.status).toBe("dead");
    // a 6th attempt is rejected as dead
    expect(verifyPairing(s, "1234", 2000).result).toEqual({ ok: false, dead: true });
  });

  it("rejects once expired", () => {
    const { result } = verifyPairing(fresh(1000), "1234", 1000 + 120001);
    expect(result).toEqual({ ok: false, expired: true });
  });
});

describe("completePairing", () => {
  function verified() { return verifyPairing(fresh(), "1234", 2000).state; } // releasingScope = aaa
  it("ok when caller scope matches releasingScope", () => {
    const { state, result } = completePairing(verified(), "users/anon-aaa/", { epk: "e", sealed: "s" }, 3000);
    expect(result).toEqual({ ok: true });
    expect(state.status).toBe("done");
    expect(state.blob).toEqual({ epk: "e", sealed: "s" });
  });
  it("forbidden when caller scope differs", () => {
    expect(completePairing(verified(), "users/anon-bbb/", {}, 3000).result)
      .toEqual({ ok: false, error: "forbidden" });
  });
  it("rejects when not yet verified", () => {
    expect(completePairing(fresh(), "users/anon-aaa/", {}, 3000).result)
      .toEqual({ ok: false, error: "not_verified" });
  });
});

describe("isExpired", () => {
  it("true past ttl", () => {
    expect(isExpired(fresh(1000), 1000 + 120001)).toBe(true);
    expect(isExpired(fresh(1000), 1000 + 1)).toBe(false);
  });
});
