import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./fakes.js";

const SQL1 = readFileSync(fileURLToPath(new URL("../migrations/0001_usage.sql", import.meta.url)), "utf8");
const SQL2 = readFileSync(fileURLToPath(new URL("../migrations/0002_buckets.sql", import.meta.url)), "utf8");

describe("0002 backfill", () => {
  it("每个非零余额账号回填成一个永不过期的 migrated 桶；零余额不回填", () => {
    const db = fakeD1(SQL1); // 先建 0001 的表
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-a/", 12345, 500000, 100, 1, 7).run();
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("users/anon-zero/", 0, 0, 0, 1, 1).run();

    db.exec(SQL2); // 跑 0002：建 bucket 表 + 回填

    const rows = db.prepare("SELECT user_sub,amount_uy,remaining_uy,source,expires_at FROM bucket").all().results;
    expect(rows.length).toBe(1);                       // 零余额账号不回填
    expect(rows[0].user_sub).toBe("users/anon-a/");
    expect(rows[0].remaining_uy).toBe(12345);
    expect(rows[0].amount_uy).toBe(12345);
    expect(rows[0].source).toBe("migrated");
    expect(rows[0].expires_at).toBe(null);             // 永不过期
  });
});
