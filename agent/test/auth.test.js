import { describe, it, expect } from "vitest";
import { b64url, hmacSign, verifySession, anonScopeFromToken, sha256hex, timingSafeEqual } from "../../functions/lib/auth.js";

// The Files API and the agent worker both verify tokens via this one module.
// These lock the contract so a future edit can't silently break auth in one place.

async function signToken(payload, secret) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

describe("verifySession", () => {
  const secret = "test-secret";

  it("accepts a valid token and returns its scope", async () => {
    const token = await signToken({ scope: "users/u/", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
    const sess = await verifySession(token, secret);
    expect(sess?.scope).toBe("users/u/");
  });

  it("rejects a tampered signature", async () => {
    const token = await signToken({ scope: "users/u/" }, secret);
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await verifySession(tampered, secret)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken({ scope: "users/u/" }, "other-secret");
    expect(await verifySession(token, secret)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ scope: "users/u/", exp: 1 }, secret);
    expect(await verifySession(token, secret)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifySession("not.a.jwt", secret)).toBeNull();
    expect(await verifySession("only-one-part", secret)).toBeNull();
  });
});

describe("anonScopeFromToken", () => {
  it("maps a valid anon token to a stable users/anon-<hash>/ scope", async () => {
    const token = "anon_" + "a".repeat(24);
    const scope = await anonScopeFromToken(token);
    expect(scope).toMatch(/^users\/anon-[0-9a-f]{32}\/$/);
    expect(await anonScopeFromToken(token)).toBe(scope); // deterministic
    expect(scope).toBe(`users/anon-${(await sha256hex(token)).slice(0, 32)}/`);
  });

  it("rejects non-anon or too-short tokens", async () => {
    expect(await anonScopeFromToken("")).toBeNull();
    expect(await anonScopeFromToken("anon_short")).toBeNull();
    expect(await anonScopeFromToken("bearer_" + "a".repeat(24))).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("is true for equal strings, false otherwise", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
