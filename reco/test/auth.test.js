import { describe, it, expect } from "vitest";
import { resolveScope, hmacSign } from "../src/auth.js";

const SECRET = "test-secret";

// 造一个与核心同构的 session JWT(HS256)。
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function mintSession(scope, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ scope, apple: true, iat: now, exp: now + 3600 }));
  const sig = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

describe("resolveScope", () => {
  it("有效 session JWT → 解出 scope", async () => {
    const t = await mintSession("users/abc/", SECRET);
    expect(await resolveScope(t, SECRET)).toBe("users/abc/");
  });

  it("被篡改的签名 → null", async () => {
    const t = await mintSession("users/abc/", SECRET);
    expect(await resolveScope(t + "x", SECRET)).toBeNull();
  });

  it("anon_ token → users/anon-<hash>/", async () => {
    const scope = await resolveScope("anon_" + "a".repeat(24), SECRET);
    expect(scope).toMatch(/^users\/anon-[0-9a-f]{32}\/$/);
  });

  it("空/垃圾 token → null", async () => {
    expect(await resolveScope("", SECRET)).toBeNull();
    expect(await resolveScope("garbage", SECRET)).toBeNull();
  });
});
