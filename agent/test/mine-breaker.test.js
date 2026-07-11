// 熔断 + ASR checkpoint 的小部件:确定性失败(如 LLM 524)不该无限重试烧钱。
import { describe, it, expect } from "vitest";
import { fakeEnv, fakeD1, usageSql } from "./fakes.js";
import { asrCkptKeyFor, mineFailKeyFor, bumpMineFail, clearMineFail, MINE_FAIL_MAX } from "../src/miner.js";
import { asrCharged } from "../src/usage_store.js";
import { ensureAccount, debit } from "../src/usage_store.js";

const AUDIO = "users/anon-x/VoiceDrop-2026-07-09-083712-132m41s-Thu-EarlyMorning.m4a";

describe("sidecar keys", () => {
  it("checkpoint/失败计数 key 落在同 stem 的 articles/ 目录", () => {
    expect(asrCkptKeyFor(AUDIO)).toBe("users/anon-x/articles/VoiceDrop-2026-07-09-083712-132m41s-Thu-EarlyMorning.asrdone.json");
    expect(mineFailKeyFor(AUDIO)).toBe("users/anon-x/articles/VoiceDrop-2026-07-09-083712-132m41s-Thu-EarlyMorning.minefail");
  });
});

describe("mine fail counter", () => {
  it("bump 递增并返回次数,clear 清零", async () => {
    const env = fakeEnv({});
    expect(await bumpMineFail(env, AUDIO, "Claude 524")).toBe(1);
    expect(await bumpMineFail(env, AUDIO, "Claude 524")).toBe(2);
    const raw = JSON.parse(env.FILES._store.get(mineFailKeyFor(AUDIO)));
    expect(raw.count).toBe(2);
    expect(raw.lastError).toContain("524");
    await clearMineFail(env, AUDIO);
    expect(env.FILES._store.has(mineFailKeyFor(AUDIO))).toBe(false);
    expect(await bumpMineFail(env, AUDIO, "x")).toBe(1);   // 清零后重新计数
  });
  it("MINE_FAIL_MAX 是个合理的小数字", () => {
    expect(MINE_FAIL_MAX).toBeGreaterThanOrEqual(3);
    expect(MINE_FAIL_MAX).toBeLessThanOrEqual(10);
  });
});

describe("asrCharged (扣费幂等)", () => {
  it("同 stem 已有 asr 扣费 → true;其他 stem/reason 不算", async () => {
    const db = fakeD1(usageSql());
    const U = "users/anon-x/";
    await ensureAccount(db, U, 1);
    expect(await asrCharged(db, U, "stemA")).toBe(false);
    await debit(db, U, 100, "asr", { asr_sec: 60, stem: "stemA" }, 2);
    expect(await asrCharged(db, U, "stemA")).toBe(true);
    expect(await asrCharged(db, U, "stemB")).toBe(false);
    await debit(db, U, 100, "mine", { stem: "stemB" }, 3);
    expect(await asrCharged(db, U, "stemB")).toBe(false); // mine 扣费不算 asr
  });
});
