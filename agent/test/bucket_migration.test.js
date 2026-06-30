import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./fakes.js";

const SQL1 = readFileSync(fileURLToPath(new URL("../migrations/0001_usage.sql", import.meta.url)), "utf8");
const SQL2 = readFileSync(fileURLToPath(new URL("../migrations/0002_buckets.sql", import.meta.url)), "utf8");

describe("0002 backfill", () => {
  it("每个非零余额账号回填成一个 1 年后过期的 migrated 桶；零余额不回填", () => {
    const db = fakeD1(SQL1); // 先建 0001 的表
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-a/", 12345, 500000, 100, 1, 7).run();
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-zero/", 0, 0, 0, 1, 1).run();

    const before = Date.now();
    db.exec(SQL2); // 跑 0002：建 bucket 表 + 回填
    const after = Date.now();

    const rows = db.prepare("SELECT user_sub,amount_uy,remaining_uy,source,created_at,expires_at FROM bucket").all().results;
    expect(rows.length).toBe(1);                       // 零余额账号不回填
    expect(rows[0].user_sub).toBe("users/anon-a/");
    expect(rows[0].remaining_uy).toBe(12345);
    expect(rows[0].amount_uy).toBe(12345);
    expect(rows[0].source).toBe("migrated");
    expect(rows[0].created_at).toBe(7);                // created_at = account.updated_at
    // expires_at = 迁移时刻 + 365 天（毫秒）。strftime 精度到秒，给 2 秒余量。
    const YEAR = 31536000000;
    expect(rows[0].expires_at).toBeGreaterThanOrEqual(before - 2000 + YEAR);
    expect(rows[0].expires_at).toBeLessThanOrEqual(after + 2000 + YEAR);
  });
});
