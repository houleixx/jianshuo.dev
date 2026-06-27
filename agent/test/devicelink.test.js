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
