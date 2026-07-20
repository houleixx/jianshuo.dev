// 存储迁移 P1（R2 → voicedrop-core D1）：refhits / invites / share_stats /
// prompt_shares 的「D1 优先、R2 兜底、双写、自愈回填」四条约定的行为测试。
import { describe, it, expect } from "vitest";
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import { writeRefhit, lookupRefhit, DEBUG_PLAINTEXT_IP } from "../../functions/lib/refhits.js";
import {
  coreWriteRefhit, coreRefhitRows, coreAllRefhits, coreCleanupRefhits,
  coreGetInvite, corePutInvite, coreBumpImportCount, coreImportCount, coreSeedImportCount,
  coreLoadPromptShares, coreUpsertPromptShare, coreRekeyPromptShare, coreMintedToday,
  coreDeleteUserData,
  coreUpsertArticleEntry, coreSetArticleFlag, coreDeleteArticle, coreListArticles,
  coreReplaceArticles, coreCountArticles,
  coreUpsertRecording, coreDeleteRecording, coreListRecordings, coreReplaceRecordings,
  coreGetIdentity, corePutIdentity, coreGetProfile, coreHasBinding, coreUpsertProfile,
  coreGetPushToken, corePutPushToken, coreDeletePushToken,
  coreGetReport, corePutReport, coreDeleteReport, corePendingReportIds, coreListReports,
} from "../../functions/lib/core-db.js";
import { hasVerifiedBinding } from "../../functions/lib/auth.js";

const SECRET = "test-secret";
const coreEnv = (seed = {}) => ({ ...fakeEnv(seed), CORE: fakeD1(coreSql()) });

describe("refhits：双写 + D1 优先查询 + R2 兜底", () => {
  it("writeRefhit 同时落 R2 对象与 D1 行", async () => {
    const env = coreEnv();
    const now = Date.now();
    await writeRefhit(env, "1.2.3.4", SECRET, "users/anon-abc/", "CODE01", now);
    // R2 侧
    const listed = await env.FILES.list({ prefix: "refhits/" });
    expect(listed.objects.length).toBe(1);
    // D1 侧
    const fp = DEBUG_PLAINTEXT_IP ? "1.2.3.4" : null;
    const rows = await coreRefhitRows(env, fp, now - 1000);
    expect(rows.length).toBe(1);
    expect(rows[0].owner).toBe("users/anon-abc/");
    expect(rows[0].token).toBe("CODE01");
  });

  it("lookupRefhit：D1 有行 → 不碰 R2 list；唯一 owner 命中", async () => {
    const env = coreEnv();
    const now = Date.now();
    await coreWriteRefhit(env, "9.9.9.9", now - 1000, "users/anon-xyz/", "TOK");
    const hit = await lookupRefhit(env, "9.9.9.9", SECRET, now);
    expect(hit).toEqual({ owner: "users/anon-xyz/", token: "TOK" });
  });

  it("lookupRefhit：D1 里多 owner → null（宁漏不错，不再看 R2）", async () => {
    const env = coreEnv();
    const now = Date.now();
    await coreWriteRefhit(env, "8.8.8.8", now - 2000, "users/anon-a/", "T1");
    await coreWriteRefhit(env, "8.8.8.8", now - 1000, "users/anon-b/", "T2");
    expect(await lookupRefhit(env, "8.8.8.8", SECRET, now)).toBeNull();
  });

  it("lookupRefhit：D1 空但 R2 有旧数据（backfill 前）→ 落回 R2 路径", async () => {
    const now = Date.now();
    const env = coreEnv({
      [`refhits/7.7.7.7/${now - 1000}`]: JSON.stringify({ owner: "users/anon-old/", token: "OLD", ts: now - 1000 }),
    });
    const hit = await lookupRefhit(env, "7.7.7.7", SECRET, now);
    expect(hit).toEqual({ owner: "users/anon-old/", token: "OLD" });
  });

  it("无 CORE 绑定 → 完全走 R2 老路径（回归保护）", async () => {
    const now = Date.now();
    const env = fakeEnv({
      [`refhits/6.6.6.6/${now - 1000}`]: JSON.stringify({ owner: "users/anon-r2/", token: "R2", ts: now - 1000 }),
    });
    const hit = await lookupRefhit(env, "6.6.6.6", SECRET, now);
    expect(hit).toEqual({ owner: "users/anon-r2/", token: "R2" });
  });

  it("coreCleanupRefhits 只清 cutoff 之前的行", async () => {
    const env = coreEnv();
    const now = Date.now();
    await coreWriteRefhit(env, "a", now - 3 * 86400000, "users/anon-1/", null);
    await coreWriteRefhit(env, "b", now - 1000, "users/anon-2/", null);
    await coreCleanupRefhits(env, now - 2 * 86400000);
    const all = await coreAllRefhits(env);
    expect(all.length).toBe(1);
    expect(all[0].fingerprint).toBe("b");
  });
});

describe("invites：UPSERT + 大小写归一", () => {
  it("corePutInvite / coreGetInvite round-trip；查无返回 false", async () => {
    const env = coreEnv();
    expect(await coreGetInvite(env, "ABC123")).toBe(false);
    await corePutInvite(env, "abc123", "users/anon-o/", "建硕", 123);
    const row = await coreGetInvite(env, "ABC123");
    expect(row.owner).toBe("users/anon-o/");
    expect(row.name).toBe("建硕");
    // 重写覆盖（改名跟着走）
    await corePutInvite(env, "ABC123", "users/anon-o/", "新名", 456);
    expect((await coreGetInvite(env, "abc123")).name).toBe("新名");
  });

  it("无 CORE 绑定 → null（调用方落 R2）", async () => {
    expect(await coreGetInvite(fakeEnv(), "ABC123")).toBeNull();
  });
});

describe("share_stats：原子自增 + 播种不回退", () => {
  it("并发 bump 不丢计数（对照 R2 RMW 的丢更新）", async () => {
    const env = coreEnv();
    await Promise.all(Array.from({ length: 25 }, () => coreBumpImportCount(env, "1234567")));
    expect(await coreImportCount(env, "1234567")).toBe(25);
  });

  it("seed 只抬升不回退", async () => {
    const env = coreEnv();
    await coreSeedImportCount(env, "7654321", 10);
    expect(await coreImportCount(env, "7654321")).toBe(10);
    await coreSeedImportCount(env, "7654321", 3); // 不回退
    expect(await coreImportCount(env, "7654321")).toBe(10);
    await coreSeedImportCount(env, "7654321", 15);
    expect(await coreImportCount(env, "7654321")).toBe(15);
  });
});

describe("prompt_shares：索引行为 + re-key + 日上限", () => {
  it("upsert / load round-trip", async () => {
    const env = coreEnv();
    await coreUpsertPromptShare(env, "users/anon-u/", "p_1", "1111111", "2026-07-20T00:00:00.000Z");
    const idx = await coreLoadPromptShares(env, "users/anon-u/");
    expect(idx.byItem).toEqual({ p_1: { code: "1111111", createdAt: "2026-07-20T00:00:00.000Z" } });
  });

  it("rekey：目标空位则挪，目标已占则不动（与 R2 版语义一致）", async () => {
    const env = coreEnv();
    await coreUpsertPromptShare(env, "users/anon-u/", "sys_a", "2222222", "2026-07-19T00:00:00.000Z");
    await coreRekeyPromptShare(env, "users/anon-u/", "sys_a", "p_new");
    let idx = await coreLoadPromptShares(env, "users/anon-u/");
    expect(idx.byItem.p_new.code).toBe("2222222");
    expect(idx.byItem.sys_a).toBeUndefined();
    // 目标已占：不动
    await coreUpsertPromptShare(env, "users/anon-u/", "sys_b", "3333333", "2026-07-19T00:00:00.000Z");
    await coreRekeyPromptShare(env, "users/anon-u/", "sys_b", "p_new");
    idx = await coreLoadPromptShares(env, "users/anon-u/");
    expect(idx.byItem.p_new.code).toBe("2222222");
    expect(idx.byItem.sys_b.code).toBe("3333333");
  });

  it("coreMintedToday 只数当日", async () => {
    const env = coreEnv();
    await coreUpsertPromptShare(env, "users/anon-u/", "a", "4444444", "2026-07-20T01:00:00.000Z");
    await coreUpsertPromptShare(env, "users/anon-u/", "b", "5555555", "2026-07-20T02:00:00.000Z");
    await coreUpsertPromptShare(env, "users/anon-u/", "c", "6666666", "2026-07-19T02:00:00.000Z");
    expect(await coreMintedToday(env, "users/anon-u/", "2026-07-20")).toBe(2);
  });
});

describe("articles 表（P2）：entry 原样存取 + 标记语义", () => {
  const scope = "users/anon-a/";
  const entry = (stem, createdAt) => JSON.stringify({ stem, title: "题", head: 2, createdAt, updatedAt: createdAt, count: 1 });

  it("upsert 保留标记；标记 off 且无 entry → 整行摘掉", async () => {
    const env = coreEnv();
    await coreSetArticleFlag(env, scope, "s1", "tags", true);
    await coreUpsertArticleEntry(env, scope, "s1", entry("s1", "2026-07-20T00:00:00.000Z"), "etag1", 100);
    let rows = await coreListArticles(env, scope);
    expect(rows.length).toBe(1);
    expect(rows[0].tags).toBe(true);                       // upsert 不覆盖标记
    expect(JSON.parse(rows[0].entry).title).toBe("题");    // entry 原样回吐
    // 只有标记、无 entry 的行：off 后整行消失
    await coreSetArticleFlag(env, scope, "s2", "empty", true);
    expect((await coreListArticles(env, scope)).length).toBe(2);
    await coreSetArticleFlag(env, scope, "s2", "empty", false);
    expect((await coreListArticles(env, scope)).length).toBe(1);
    // 有 entry 的行：off 只清位不删行
    await coreSetArticleFlag(env, scope, "s1", "tags", false);
    rows = await coreListArticles(env, scope);
    expect(rows.length).toBe(1);
    expect(rows[0].tags).toBe(false);
  });

  it("created_ms 倒序 + replace 整体对账 + count", async () => {
    const env = coreEnv();
    await coreUpsertArticleEntry(env, scope, "old", entry("old", "2026-07-18T00:00:00.000Z"), null, 100);
    await coreUpsertArticleEntry(env, scope, "new", entry("new", "2026-07-20T00:00:00.000Z"), null, 300);
    let rows = await coreListArticles(env, scope);
    expect(rows.map((r) => r.stem)).toEqual(["new", "old"]);
    await coreReplaceArticles(env, scope, [
      { stem: "only", entryJson: entry("only", "x"), fp: "e", createdMs: 5, empty: false, blocked: true, tags: false },
    ]);
    rows = await coreListArticles(env, scope);
    expect(rows.length).toBe(1);
    expect(rows[0].blocked).toBe(true);
    expect(await coreCountArticles(env, scope)).toBe(1);
    await coreDeleteArticle(env, scope, "only");
    expect(await coreCountArticles(env, scope)).toBe(0);
  });
});

describe("recordings 表（P2）", () => {
  it("upsert / delete / replace round-trip", async () => {
    const env = coreEnv();
    const scope = "users/anon-r/";
    await coreUpsertRecording(env, scope, "VoiceDrop-a.m4a", "2026-07-20T01:00:00.000Z");
    await coreUpsertRecording(env, scope, "VoiceDrop-b.m4a", "2026-07-20T02:00:00.000Z");
    let items = await coreListRecordings(env, scope);
    expect(Object.keys(items).sort()).toEqual(["VoiceDrop-a.m4a", "VoiceDrop-b.m4a"]);
    expect(items["VoiceDrop-a.m4a"].uploaded).toBe("2026-07-20T01:00:00.000Z");
    await coreDeleteRecording(env, scope, "VoiceDrop-a.m4a");
    items = await coreListRecordings(env, scope);
    expect(Object.keys(items)).toEqual(["VoiceDrop-b.m4a"]);
    await coreReplaceRecordings(env, scope, { "VoiceDrop-c.m4a": { uploaded: "t" } });
    items = await coreListRecordings(env, scope);
    expect(Object.keys(items)).toEqual(["VoiceDrop-c.m4a"]);
  });
});

describe("identities + user_profiles（P3）", () => {
  it("identity first-write-wins；查无 false / 不可用 null", async () => {
    const env = coreEnv();
    expect(await coreGetIdentity(env, "apple", "SUB1")).toBe(false);
    expect(await coreGetIdentity(fakeEnv(), "apple", "SUB1")).toBeNull();
    await corePutIdentity(env, "apple", "SUB1", "users/anon-a/", 100);
    await corePutIdentity(env, "apple", "SUB1", "users/anon-OTHER/", 200); // 不覆盖
    expect(await coreGetIdentity(env, "apple", "SUB1")).toBe("users/anon-a/");
  });

  it("profile 行级合并：name first-write-wins（不传就不动）", async () => {
    const env = coreEnv();
    const scope = "users/anon-p/";
    await coreUpsertProfile(env, scope, { apple_sub: "S", email: "a@b.c", name: "建硕", linked_at: 1, last_seen_at: 1 });
    await coreUpsertProfile(env, scope, { last_seen_at: 2 }); // 只刷 last_seen，不传 name → COALESCE 保旧
    const p = await coreGetProfile(env, scope);
    expect(p.name).toBe("建硕");
    expect(p.email).toBe("a@b.c");
    expect(p.last_seen_at).toBe(2);
  });

  it("hasBinding / hasVerifiedBinding：D1 有绑定 → true，无 → false", async () => {
    const env = coreEnv();
    const scope = "users/anon-b/";
    expect(await coreHasBinding(env, scope)).toBe(false);
    expect(await hasVerifiedBinding(env, scope)).toBe(false);      // D1 空行也算无绑定
    await coreUpsertProfile(env, scope, { wechat_openid: "OPENID", last_seen_at: 1 });
    expect(await coreHasBinding(env, scope)).toBe(true);
    expect(await hasVerifiedBinding(env, scope)).toBe(true);
  });

  it("hasVerifiedBinding：无 D1 绑定 → 落回 R2 ACCOUNT.json", async () => {
    const scope = "users/anon-legacy/";
    const env = fakeEnv({ [`${scope}ACCOUNT.json`]: JSON.stringify({ appleSub: "OLD" }) });
    expect(await hasVerifiedBinding(env, scope)).toBe(true);       // 无 CORE 绑定 → R2 命中
  });
});

describe("push_tokens（P3）", () => {
  it("put / get / delete round-trip", async () => {
    const env = coreEnv();
    const scope = "users/anon-pt/";
    expect(await coreGetPushToken(env, scope)).toBe(false);
    await corePutPushToken(env, scope, "TOK1", "prod", 100);
    expect(await coreGetPushToken(env, scope)).toEqual({ token: "TOK1", env: "prod" });
    await corePutPushToken(env, scope, "TOK2", "dev", 200); // 覆盖
    expect((await coreGetPushToken(env, scope)).token).toBe("TOK2");
    await coreDeletePushToken(env, scope);
    expect(await coreGetPushToken(env, scope)).toBe(false);
  });
});

describe("community_reports（P3）", () => {
  it("put / get / pending 集 / list / delete", async () => {
    const env = coreEnv();
    await corePutReport(env, "abc123def456", "pending", 100, [{ by: "users/anon-x/", at: 100, reason: "spam" }]);
    const rec = await coreGetReport(env, "abc123def456");
    expect(rec.reporters.length).toBe(1);
    expect(rec.status).toBe("pending");
    const pend = await corePendingReportIds(env);
    expect(pend.has("abc123def456")).toBe(true);
    const list = await coreListReports(env);
    expect(list[0].shareId).toBe("abc123def456");
    await coreDeleteReport(env, "abc123def456");
    expect(await coreGetReport(env, "abc123def456")).toBe(false);
    expect((await corePendingReportIds(env)).size).toBe(0);
  });
});

describe("销号清理", () => {
  it("coreDeleteUserData 清全部关联表（含 P3 身份/档案/push）", async () => {
    const env = coreEnv();
    const scope = "users/anon-del/";
    await coreUpsertPromptShare(env, scope, "p_1", "9999999", "2026-07-20T00:00:00.000Z");
    await coreBumpImportCount(env, "9999999");
    await corePutInvite(env, "DEAD01", scope, "", 1);
    await coreWriteRefhit(env, "5.5.5.5", Date.now(), scope, "DEAD01");
    await corePutIdentity(env, "apple", "DELSUB", scope, 1);
    await coreUpsertProfile(env, scope, { apple_sub: "DELSUB", last_seen_at: 1 });
    await corePutPushToken(env, scope, "DELTOK", "prod", 1);
    // 别人的数据不受影响
    await coreUpsertPromptShare(env, "users/anon-keep/", "p_2", "8888888", "2026-07-20T00:00:00.000Z");
    await coreDeleteUserData(env, scope);
    expect((await coreLoadPromptShares(env, scope)).byItem).toEqual({});
    expect(await coreGetInvite(env, "DEAD01")).toBe(false);
    expect(await coreImportCount(env, "9999999")).toBe(false);
    expect(await coreGetIdentity(env, "apple", "DELSUB")).toBe(false);
    expect(await coreGetProfile(env, scope)).toBe(false);
    expect(await coreGetPushToken(env, scope)).toBe(false);
    expect((await coreLoadPromptShares(env, "users/anon-keep/")).byItem.p_2.code).toBe("8888888");
  });
});
