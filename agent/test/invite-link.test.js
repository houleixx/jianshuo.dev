// test/invite-link.test.js — 邀请码：GET /agent/referral/link 铸码/写穿 + 落地页渲染 +
// claim 用邀请码归因（ownerFromToken 的 invites/ 分支）。
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql, fakeEnv } from "./fakes.js";
import { handleReferralRoutes, inviteCodeForScope } from "../src/referral.js";
import { rewardCopy, invitePageHtml, onRequest as invitePage } from "../../functions/voicedrop/i/[code].js";

const SECRET = "test-secret";
const OWNER = "users/anon-abcdef0123456789abcdef0123456789/";
const OWNER_CODE = "ABCDEF"; // anon hex 前 6 位大写
const NEWBIE = "users/anon-99999999999999999999999999999999/";

// 匿名 token 直接过不了 verifySession，但 anonScopeFromToken 需要真 anon_ 前缀 token；
// 这里走 session 路径（scope 直接写进 payload），与 referral.test.js 同款。
import { hmacSign, b64url } from "../../functions/lib/auth.js";
async function makeToken(scope) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, apple: false }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

function linkReq(token) {
  return new Request("https://jianshuo.dev/agent/referral/link", {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
const URL_LINK = new URL("https://jianshuo.dev/agent/referral/link");
const URL_CLAIM = new URL("https://jianshuo.dev/agent/referral/claim");

let env;
beforeEach(() => {
  env = fakeEnv({});
  env.SESSION_SECRET = SECRET;
});

describe("inviteCodeForScope", () => {
  it("derives the 6-hex uppercase code from the anon sub (matches the app's short tag)", async () => {
    expect(await inviteCodeForScope(env, OWNER, SECRET)).toBe(OWNER_CODE);
  });
  it("extends to 10 chars when 6 is taken by someone else", async () => {
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: "users/anon-other/" }));
    expect(await inviteCodeForScope(env, OWNER, SECRET)).toBe("ABCDEF0123");
  });
  it("returns the same code when the entry is already mine", async () => {
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: OWNER }));
    expect(await inviteCodeForScope(env, OWNER, SECRET)).toBe(OWNER_CODE);
  });
  it("derives a stable HMAC code for non-anon scopes", async () => {
    const a = await inviteCodeForScope(env, "users/team-abc/", SECRET);
    const b = await inviteCodeForScope(env, "users/team-abc/", SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe("GET /agent/referral/link", () => {
  it("401 without a token", async () => {
    const r = await handleReferralRoutes(URL_LINK, linkReq(null), env);
    expect(r.status).toBe(401);
  });
  it("mints the code, writes through invites/<code> with the profile name", async () => {
    await env.FILES.put(`${OWNER}CLAUDE.json`, JSON.stringify({ profile: { name: "舒博" } }));
    await env.FILES.put("config/mint-rate.json", JSON.stringify({ suanliPerCoin: 5.6 }));
    const r = await handleReferralRoutes(URL_LINK, linkReq(await makeToken(OWNER)), env);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.code).toBe(OWNER_CODE);
    expect(j.url).toBe(`https://voicedrop.cn/i/${OWNER_CODE}`);
    expect(j.name).toBe("舒博");
    expect(j.enabled).toBe(true);
    expect(j.suanliInviter).toBe(Math.round(9 * 5.6));
    expect(j.suanliFriend).toBe(Math.round(9 * 5.6));
    const stored = JSON.parse(await (await env.FILES.get(`invites/${OWNER_CODE}`)).text());
    expect(stored.owner).toBe(OWNER);
    expect(stored.name).toBe("舒博");
  });
  it("no rate published → suanli numbers are 0 (client hides them)", async () => {
    const r = await handleReferralRoutes(URL_LINK, linkReq(await makeToken(OWNER)), env);
    const j = await r.json();
    expect(j.suanliInviter).toBe(0);
    expect(j.suanliFriend).toBe(0);
    expect(j.code).toBe(OWNER_CODE);
  });
  it("name refreshes on each mint (rename propagates to the landing page)", async () => {
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: OWNER, name: "旧名" }));
    await env.FILES.put(`${OWNER}CLAUDE.json`, JSON.stringify({ profile: { name: "新名" } }));
    await handleReferralRoutes(URL_LINK, linkReq(await makeToken(OWNER)), env);
    const stored = JSON.parse(await (await env.FILES.get(`invites/${OWNER_CODE}`)).text());
    expect(stored.name).toBe("新名");
  });
});

describe("claim with an invite code token", () => {
  it("resolves invites/<code> to the owner and pays both sides", async () => {
    const db = fakeD1(usageSql());
    env.USAGE = db;
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: OWNER, name: "舒博" }));
    const tok = await makeToken(NEWBIE);
    const req = new Request("https://jianshuo.dev/agent/referral/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "CF-Connecting-IP": "9.9.9.9" },
      // requireDeviceCheck 默认 true → 显式关掉（生产线上也是 false）
      body: JSON.stringify({ source: "clipboard", token: OWNER_CODE }),
    });
    await env.FILES.put("config/referral.json", JSON.stringify({ enabled: true, authorCoins: 9, newUserCoins: 9, dailyCapPerOwner: 30, requireDeviceCheck: false }));
    const r = await handleReferralRoutes(URL_CLAIM, req, env);
    const j = await r.json();
    expect(j.attributed).toBe(true);
    expect(j.suanli.you).toBeGreaterThan(0);
    expect(j.suanli.author).toBeGreaterThan(0);
  });
  it("lowercase clipboard code still resolves (uppercase normalization)", async () => {
    const db = fakeD1(usageSql());
    env.USAGE = db;
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: OWNER }));
    await env.FILES.put("config/referral.json", JSON.stringify({ enabled: true, authorCoins: 9, newUserCoins: 9, dailyCapPerOwner: 30, requireDeviceCheck: false }));
    const tok = await makeToken(NEWBIE);
    const req = new Request("https://jianshuo.dev/agent/referral/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "CF-Connecting-IP": "9.9.9.9" },
      body: JSON.stringify({ source: "clipboard", token: OWNER_CODE.toLowerCase() }),
    });
    const r = await handleReferralRoutes(URL_CLAIM, req, env);
    expect((await r.json()).attributed).toBe(true);
  });
  it("self-invite is rejected", async () => {
    const db = fakeD1(usageSql());
    env.USAGE = db;
    await env.FILES.put(`invites/${OWNER_CODE}`, JSON.stringify({ owner: OWNER }));
    await env.FILES.put("config/referral.json", JSON.stringify({ enabled: true, authorCoins: 9, newUserCoins: 9, dailyCapPerOwner: 30, requireDeviceCheck: false }));
    const tok = await makeToken(OWNER);
    const req = new Request("https://jianshuo.dev/agent/referral/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "CF-Connecting-IP": "9.9.9.9" },
      body: JSON.stringify({ source: "clipboard", token: OWNER_CODE }),
    });
    const r = await handleReferralRoutes(URL_CLAIM, req, env);
    expect((await r.json()).reason).toBe("self");
  });
});

describe("invite landing page", () => {
  function ctx(code, extraSeed = {}) {
    const e = fakeEnv(extraSeed);
    e.SESSION_SECRET = SECRET;
    const tasks = [];
    return {
      params: { code },
      env: e,
      request: new Request(`https://jianshuo.dev/voicedrop/i/${code}`, {
        headers: { "CF-Connecting-IP": "8.8.4.4", "x-forwarded-host": "voicedrop.cn" },
      }),
      waitUntil: (p) => tasks.push(p),
      next: () => new Response("static", { status: 200 }),
      _tasks: tasks,
      _env: e,
    };
  }

  it("renders the inviter name, hero, download buttons and clipboard hook", async () => {
    const c = ctx(OWNER_CODE, {
      [`invites/${OWNER_CODE}`]: JSON.stringify({ owner: OWNER, name: "舒博" }),
      "config/mint-rate.json": JSON.stringify({ suanliPerCoin: 5.6 }),
      "config/referral.json": JSON.stringify({ enabled: true, authorCoins: 9, newUserCoins: 9 }),
    });
    const r = await invitePage(c);
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).toContain("舒博");
    expect(h).toContain("邀请你");
    expect(h).toContain("动动嘴");
    expect(h).toContain("apps.apple.com");
    expect(h).toContain("voicedrop/apk");
    expect(h).toContain("navigator.clipboard");
    expect(h).toContain(`各得 ${Math.round(9 * 5.6)} 算力`);
    expect(h).toContain("已自动记住舒博的邀请");
    // canonical 链接是干净的 voicedrop.cn/i/<码>（经反代时）
    expect(h).toContain(`https://voicedrop.cn/i/${OWNER_CODE}`);
    // IP 指纹已排队写入
    await Promise.all(c._tasks);
    const hits = await c._env.FILES.list({ prefix: "refhits/" });
    expect(hits.objects.length).toBe(1);
    expect(JSON.parse(await (await c._env.FILES.get(hits.objects[0].key)).text()).owner).toBe(OWNER);
  });
  it("lowercase code in the URL resolves (uppercase normalization)", async () => {
    const c = ctx(OWNER_CODE.toLowerCase(), {
      [`invites/${OWNER_CODE}`]: JSON.stringify({ owner: OWNER, name: "" }),
    });
    const r = await invitePage(c);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("你的朋友邀请你一起用");
  });
  it("unknown code → 404 page, no refhit", async () => {
    const c = ctx("ZZZZZZ");
    const r = await invitePage(c);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("不存在");
    expect(c._tasks.length).toBe(0);
  });
  it("malformed segment falls through to static assets", async () => {
    const c = ctx("has space!");
    const r = await invitePage(c);
    expect(await r.text()).toBe("static");
  });
  it("rewardCopy degrades honestly", () => {
    expect(rewardCopy("舒博", null, { enabled: false })).toBe("");
    expect(rewardCopy("舒博", null, { enabled: true, authorCoins: 9, newUserCoins: 9 }))
      .toContain("都能得算力奖励");
    expect(rewardCopy("", { suanliPerCoin: 10 }, { enabled: true, authorCoins: 9, newUserCoins: 9 }))
      .toContain("各得 90 算力");
    expect(rewardCopy("舒博", { suanliPerCoin: 10 }, { enabled: true, authorCoins: 18, newUserCoins: 9 }))
      .toContain("你得 <b>90 算力</b>");
  });
  it("escapes a hostile inviter name", () => {
    const h = invitePageHtml({ name: '<script>alert(1)</script>', title: "t", og: { url: "u" }, rate: null, cfg: { enabled: false } });
    expect(h).not.toContain("<script>alert");
  });
});
