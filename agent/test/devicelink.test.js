import { describe, it, expect } from "vitest";
import { genDistinctCodes, buildBroadcastMessage, CODE_TTL_MS, MAX_ATTEMPTS, MAX_MATCH } from "../src/devicelink.js";

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
