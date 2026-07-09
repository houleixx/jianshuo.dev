// test/referral.test.js — 邀请奖励：中文账单名 + 配置默认值
import { describe, it, expect } from "vitest";
import { REASON_ZH, REFERRAL_DEFAULTS } from "../src/usage.js";

describe("referral constants", () => {
  it("has Chinese ledger names", () => {
    expect(REASON_ZH["referral_author"]).toBe("邀请奖励");
    expect(REASON_ZH["referral_new"]).toBe("受邀赠送");
  });
  it("has defaults", () => {
    expect(REFERRAL_DEFAULTS).toEqual({
      enabled: true, authorCoins: 12, newUserCoins: 6,
      dailyCapPerOwner: 30, requireDeviceCheck: true,
    });
  });
});
