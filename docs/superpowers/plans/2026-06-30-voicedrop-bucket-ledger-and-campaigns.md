# VoiceDrop 算力分桶账本 + 活动赠送 实施计划（P1 + P2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 VoiceDrop 算力账本从「单一余额」升级为「带过期日的分桶记账」（惰性过期、最快过期先扣），并在其上提供带过期的活动赠送（单发 + 批量）。

**Architecture:** 新增 `bucket` 表为算力唯一真相；余额 = `SUM(remaining_uy) WHERE 未过期`；扣费按「最快过期先扣」遍历活桶递减；`account` 行保留作 `granted_uy/spent_uy` 统计与 `balance_uy` 缓存。注册赠送/活动赠送/（未来）订阅都只是「往桶里写一行、盖不同过期日」。

**Tech Stack:** Cloudflare Workers (ES modules) · D1 (SQLite) · vitest + better-sqlite3 测试 · 无新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-06-30-voicedrop-subscription-credits-design.md`（P3/P4 订阅闭环不在本计划，待 P1 落地后另写）。

## Global Constraints

- 金额单位是**微元 `uy`（整数）**：`1 算力 = ¥1/23`，`suanliToUY/uyToSuanli` 已在 `src/usage.js`。新代码全程用整数 `uy`，换算用既有 helper。
- `RATE = 23 算力/¥`（成本价），不得改动。售价相关常量只新增、不覆盖成本常量。
- 过期一律**惰性**：用 `expires_at IS NULL OR expires_at > now` 过滤，**不写定时任务、不写 `expire` 类型流水**。
- `expires_at` 为 `NULL` 表示永不过期。
- 所有 `now` 一律由调用方传入毫秒时间戳（路由层用 `Date.now()`），便于测试注入。
- 沿用既有代码风格（`src/usage_store.js` 现有写法：`db.prepare(...).bind(...).run()/.first()/.all()`、`db.batch([...])`）。
- 测试用 `fakeD1(sql)`（`test/fakes.js`，better-sqlite3 跑真实迁移 SQL）。
- 每次 `git commit` 末尾带两行 footer：
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` 和
  `Claude-Session: https://claude.ai/code/session_011ZBiRptoB5KAVQqn8CRsyR`。
- 测试运行器：`npx vitest run <path>`（单文件）/ `npm test`（全量）。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `agent/migrations/0002_buckets.sql` | 建 `bucket` 表 + 回填既有余额 | 新建 (T2) |
| `agent/src/usage.js` | 定价/单位常量 + 过期天数常量 + `expiryAfterDays` | 改 (T1) |
| `agent/src/usage_store.js` | 分桶账本核心：`balanceUY/grantBucket/ensureAccount/debit/allAccounts` | 改 (T3–T5) |
| `agent/src/index.js` | 余额路由/admin 路由按桶算；grant 路由+批量端点 | 改 (T6, T7, T8) |
| `agent/test/fakes.js` | 新增 `usageSql()` 读 0001+0002 | 改 (T2) |
| `agent/test/bucket_migration.test.js` | 0002 回填测试 | 新建 (T2) |
| `agent/test/usage_store.test.js` | 分桶语义测试 | 改 (T2–T5) |
| `agent/test/usage_routes.test.js` | 余额/grant/批量路由测试 | 改 (T6–T8) |
| `agent/test/usage_edit.test.js`, `usage_mine.test.js` | 仅切换 SQL 加载到 `usageSql()` | 改 (T2) |

> 所有路径相对仓库根 `jianshuo.dev/`。命令在 `agent/` 目录下执行。

---

## Task 1: 过期常量与单位（usage.js）

**Files:**
- Modify: `agent/src/usage.js`（在文件末尾、`editGate` 之后追加）
- Test: `agent/test/usage.test.js`（追加一个 `describe`）

**Interfaces:**
- Produces:
  - `DAY_MS = 86400000`（number）
  - `SIGNUP_EXPIRE_DAYS = 365`、`CAMPAIGN_EXPIRE_DAYS = 90`、`SUB_GRANT_SUANLI = 200`（number 常量）
  - `expiryAfterDays(now: number, days: number) => number`（返回 `now + days*DAY_MS`）

- [ ] **Step 1: 写失败测试**（追加到 `agent/test/usage.test.js` 末尾）

```js
import { DAY_MS, SIGNUP_EXPIRE_DAYS, CAMPAIGN_EXPIRE_DAYS, expiryAfterDays } from "../src/usage.js";

describe("expiry units", () => {
  it("DAY_MS is one day in ms", () => {
    expect(DAY_MS).toBe(86400000);
  });
  it("signup is 365d, campaign is 90d", () => {
    expect(SIGNUP_EXPIRE_DAYS).toBe(365);
    expect(CAMPAIGN_EXPIRE_DAYS).toBe(90);
  });
  it("expiryAfterDays adds days to now", () => {
    expect(expiryAfterDays(1000, 90)).toBe(1000 + 90 * 86400000);
  });
});
```

> 注：`usage.test.js` 顶部已 `import { describe, it, expect } from "vitest"`。若该文件没有这些导入，先补一行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage.test.js`
Expected: FAIL，报 `expiryAfterDays is not a function` / 常量 undefined。

- [ ] **Step 3: 实现常量与 helper**（追加到 `agent/src/usage.js` 末尾）

```js
// ── 过期 / 订阅常量（分桶账本）─────────────────────────────────────────────
export const DAY_MS = 86400000;
export const SIGNUP_EXPIRE_DAYS  = 365;   // 注册赠送 1 年
export const CAMPAIGN_EXPIRE_DAYS = 90;   // 活动赠送默认 3 个月
export const SUB_GRANT_SUANLI = 200;      // 包月发放（P3 用，先定义集中管理）
export const expiryAfterDays = (now, days) => now + days * DAY_MS;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/usage.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add agent/src/usage.js agent/test/usage.test.js
git commit -m "feat(usage): add bucket expiry constants and expiryAfterDays helper"
```

---

## Task 2: bucket 表迁移 + 回填 + 测试基建

**Files:**
- Create: `agent/migrations/0002_buckets.sql`
- Modify: `agent/test/fakes.js`（新增 `usageSql()` 导出）
- Create: `agent/test/bucket_migration.test.js`
- Modify: `agent/test/usage_store.test.js`、`usage_routes.test.js`、`usage_edit.test.js`、`usage_mine.test.js`（把 SQL 常量改成 `usageSql()`）

**Interfaces:**
- Produces:
  - `bucket(id, user_sub, amount_uy, remaining_uy, source, created_at, expires_at)` 表 + 索引 `idx_bucket_user_exp`
  - `usageSql(): string`（读 `0001_usage.sql` + `0002_buckets.sql` 拼接，供 fakeD1 建库）

- [ ] **Step 1: 写失败的回填测试**（新建 `agent/test/bucket_migration.test.js`）

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/bucket_migration.test.js`
Expected: FAIL（`no such file` 或 `no such table: bucket`，因为 0002 还不存在）。

- [ ] **Step 3: 写迁移**（新建 `agent/migrations/0002_buckets.sql`）

```sql
-- migrations/0002_buckets.sql — 算力分桶账本
CREATE TABLE IF NOT EXISTS bucket (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub     TEXT NOT NULL,
  amount_uy    INTEGER NOT NULL,        -- 到账原始额度（微元）
  remaining_uy INTEGER NOT NULL,        -- 剩余，扣费递减；透支可为负
  source       TEXT NOT NULL,           -- 'signup'|'subscription'|'campaign:<id>'|'migrated'|'overdraft'
  created_at   INTEGER NOT NULL,        -- ms epoch
  expires_at   INTEGER                  -- ms epoch；NULL = 永不过期
);
CREATE INDEX IF NOT EXISTS idx_bucket_user_exp ON bucket(user_sub, expires_at);

-- 回填：把每个非零余额迁成一个永不过期的桶（不给既有余额追加过期日，避免意外清零）
INSERT INTO bucket (user_sub, amount_uy, remaining_uy, source, created_at, expires_at)
SELECT user_sub, balance_uy, balance_uy, 'migrated', updated_at, NULL
FROM account WHERE balance_uy <> 0;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/bucket_migration.test.js`
Expected: PASS。

- [ ] **Step 5: 新增 `usageSql()` 测试 helper**（在 `agent/test/fakes.js` 末尾追加；文件已 `import Database from "better-sqlite3"`，需再加 node:fs / node:url 导入到文件顶部）

在 `agent/test/fakes.js` **顶部**加：

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
```

在 `agent/test/fakes.js` **末尾**加：

```js
// 读取 usage 相关全部迁移（0001 + 0002），供 fakeD1 建一个有 bucket 表的库。
export function usageSql() {
  const f = (name) => readFileSync(fileURLToPath(new URL("../migrations/" + name, import.meta.url)), "utf8");
  return f("0001_usage.sql") + "\n" + f("0002_buckets.sql");
}
```

- [ ] **Step 6: 把四个 usage 测试切到 `usageSql()`**

在 `test/usage_store.test.js`、`test/usage_routes.test.js`、`test/usage_edit.test.js`、`test/usage_mine.test.js` 中：

1. 把 `import { fakeD1 } from "./fakes.js";` 改成 `import { fakeD1, usageSql } from "./fakes.js";`
2. 删除各自的 `const SQL = readFileSync(...0001_usage.sql...)` 那一行，替换为：
   ```js
   const SQL = usageSql();
   ```
3. 若删除后 `readFileSync` / `fileURLToPath` / `node:fs` / `node:url` 在该文件不再被使用，一并删掉这些导入（避免 lint 噪音）。`usage_routes.test.js` 仍保留它需要的其它导入。

- [ ] **Step 7: 跑这四个测试确认仍绿**（行为未变，只是多了张空 bucket 表）

Run: `npx vitest run test/usage_store.test.js test/usage_routes.test.js test/usage_edit.test.js test/usage_mine.test.js`
Expected: PASS（此时旧逻辑仍读 `balance_uy`，bucket 表为空不影响）。

- [ ] **Step 8: 提交**

```bash
git add agent/migrations/0002_buckets.sql agent/test/fakes.js agent/test/bucket_migration.test.js \
        agent/test/usage_store.test.js agent/test/usage_routes.test.js \
        agent/test/usage_edit.test.js agent/test/usage_mine.test.js
git commit -m "feat(usage): add bucket table + backfill migration and usageSql test helper"
```

---

## Task 3: 余额与发放走桶（balanceUY + grantBucket）

**Files:**
- Modify: `agent/src/usage_store.js`（新增两个函数；顶部导入补常量）
- Test: `agent/test/usage_store.test.js`（新增一个 `describe("buckets")`）

**Interfaces:**
- Consumes: `SIGNUP_GRANT_UY`, `SIGNUP_EXPIRE_DAYS`, `DAY_MS`（来自 `usage.js`，T1）
- Produces:
  - `balanceUY(db, userSub, now) => Promise<number>`：未过期桶 `remaining_uy` 之和
  - `grantBucket(db, userSub, amountUY, source, expiresAt, now) => Promise<void>`：写一个桶 + 更新 `account.granted_uy/balance_uy` + 记 `grant` 流水

- [ ] **Step 1: 写失败测试**（追加到 `agent/test/usage_store.test.js`，并在顶部 import 补 `balanceUY, grantBucket`）

把文件顶部的
`import { ensureAccount, getBalanceUY, debit, grant, getLedger, editCount, allAccounts } from "../src/usage_store.js";`
改为
`import { ensureAccount, debit, getLedger, editCount, allAccounts, balanceUY, grantBucket } from "../src/usage_store.js";`

（移除将被删的 `getBalanceUY` 和 `grant`，见 T4/T7。）追加：

```js
describe("buckets", () => {
  it("balanceUY sums only live buckets", async () => {
    await grantBucket(db, U, 1000, "campaign:x", 5000, 1);   // 过期=5000
    await grantBucket(db, U, 2000, "campaign:y", null, 1);   // 永不过期
    expect(await balanceUY(db, U, 1)).toBe(3000);            // now=1 都活
    expect(await balanceUY(db, U, 6000)).toBe(2000);         // now=6000，第一个已过期
  });
  it("grantBucket bumps granted_uy and writes a grant ledger row", async () => {
    await grantBucket(db, U, 1000, "campaign:x", null, 1);
    const led = await getLedger(db, U, 10);
    expect(led[0].kind).toBe("grant");
    expect(led[0].amount_uy).toBe(1000);
    expect(led[0].reason).toBe("campaign:x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_store.test.js -t buckets`
Expected: FAIL（`balanceUY is not a function`）。

- [ ] **Step 3: 实现 balanceUY + grantBucket**

在 `agent/src/usage_store.js` 顶部导入改为：

```js
import { SIGNUP_GRANT_UY, SIGNUP_EXPIRE_DAYS, DAY_MS } from "./usage.js";
```

在文件中新增（放在 `ensureAccount` 之前或之后均可）：

```js
// 未过期桶余额（惰性过期）：expires_at NULL 视为永不过期。
export async function balanceUY(db, userSub, now) {
  const row = await db.prepare(
    "SELECT COALESCE(SUM(remaining_uy),0) AS bal FROM bucket WHERE user_sub=? AND (expires_at IS NULL OR expires_at > ?)"
  ).bind(userSub, now).first();
  return row ? row.bal : 0;
}

// 发放一个桶：写 bucket + 更新 account 统计/缓存 + 记 grant 流水。
export async function grantBucket(db, userSub, amountUY, source, expiresAt, now) {
  await ensureAccount(db, userSub, now);
  await db.prepare(
    "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, amountUY, amountUY, source, now, expiresAt ?? null).run();
  const bal = await balanceUY(db, userSub, now);
  const up = db.prepare("UPDATE account SET granted_uy=granted_uy+?, balance_uy=?, updated_at=? WHERE user_sub=?")
    .bind(amountUY, bal, now, userSub);
  const led = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "grant", amountUY, source, null, bal);
  await db.batch([up, led]);
}
```

> `ensureAccount` 在 T4 才改成「创建 signup 桶」。本步 `grantBucket` 已调用它——T3 阶段它仍是旧实现（只建 account 行、不建桶），不影响本测试（测试只验 `campaign` 桶之和）。T4 完成后语义自洽。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/usage_store.test.js -t buckets`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add agent/src/usage_store.js agent/test/usage_store.test.js
git commit -m "feat(usage): add balanceUY (lazy expiry) and grantBucket"
```

---

## Task 4: ensureAccount 创建 signup 桶并返回活余额

**Files:**
- Modify: `agent/src/usage_store.js`（重写 `ensureAccount`，删除 `getBalanceUY`）
- Test: `agent/test/usage_store.test.js`（改写既有两个 ensureAccount 相关用例）

**Interfaces:**
- Produces: `ensureAccount(db, userSub, now) => Promise<number>`：保证 account 行存在；**仅在首次创建**时写一个 `signup` 桶（500 算力、`now + 365d` 过期）+ `grant` 流水；返回 `balanceUY(now)`。
- 移除：`getBalanceUY`（被 `balanceUY` 取代）。

- [ ] **Step 1: 改写测试**

在 `agent/test/usage_store.test.js` 中：

(a) 把首个用例改为按桶断言：

```js
  it("ensureAccount grants signup once into a 1y bucket, idempotent", async () => {
    expect(await ensureAccount(db, U, 1)).toBe(SIGNUP_GRANT_UY);
    expect(await ensureAccount(db, U, 2)).toBe(SIGNUP_GRANT_UY); // 不二次发放
    expect(await balanceUY(db, U, 2)).toBe(SIGNUP_GRANT_UY);
    const buckets = db.prepare("SELECT source,expires_at,remaining_uy FROM bucket WHERE user_sub=?").bind(U).all().results;
    expect(buckets.length).toBe(1);
    expect(buckets[0].source).toBe("signup");
    expect(buckets[0].expires_at).toBe(1 + 365 * 86400000); // 按首次 now=1 盖 1 年
    expect((await getLedger(db, U, 10)).length).toBe(1);
  });
```

(b) 把「debit can overdraw」用例里的 `getBalanceUY(db, U)` 改成 `balanceUY(db, U, 2)`（now 与该用例 debit 的 now 一致）：

```js
  it("debit lowers balance + writes ledger; can overdraw", async () => {
    await ensureAccount(db, U, 1);
    await debit(db, U, SIGNUP_GRANT_UY + 5, "mine", { stem: "s1" }, 2);
    expect(await balanceUY(db, U, 2)).toBe(-5);
    const led = await getLedger(db, U, 10);
    expect(led[0].kind).toBe("spend");
    expect(led[0].balance_uy).toBe(-5);
  });
```

(c) 把「grant adds + ensures account」用例改用 `grantBucket`：

```js
  it("grantBucket on a fresh user also triggers signup, then adds", async () => {
    await grantBucket(db, U, 1000, "campaign:x", null, 1);
    expect(await balanceUY(db, U, 1)).toBe(SIGNUP_GRANT_UY + 1000);
  });
```

(d) 把并发首触用例改成「已有桶则不二次发 signup」：

```js
  it("concurrent first-touch: existing account+bucket → no second signup", async () => {
    const alreadySpent = 999;
    const currentBal = SIGNUP_GRANT_UY - alreadySpent;
    db.prepare("INSERT INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .bind(U, currentBal, SIGNUP_GRANT_UY, alreadySpent, 1, 1).run();
    db.prepare("INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(U, SIGNUP_GRANT_UY, currentBal, "signup", 1, null).run();

    const bal = await ensureAccount(db, U, 200);
    expect(bal).toBe(currentBal);
    const n = db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE user_sub=?").bind(U).first().n;
    expect(n).toBe(1); // 没有第二个 signup 桶
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_store.test.js`
Expected: FAIL（旧 `ensureAccount` 不建桶，新断言不满足）。

- [ ] **Step 3: 重写 ensureAccount，删除 getBalanceUY**

把 `agent/src/usage_store.js` 里现有的 `ensureAccount` 和 `getBalanceUY` 两个函数整体替换为：

```js
export async function ensureAccount(db, userSub, now) {
  const res = await db.prepare(
    "INSERT OR IGNORE INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, SIGNUP_GRANT_UY, SIGNUP_GRANT_UY, 0, now, now).run();

  // 只有真正新建该行的调用者（changes===1）发放 signup 桶，并发首触不会二次发。
  if (res && res.meta && res.meta.changes === 1) {
    const exp = now + SIGNUP_EXPIRE_DAYS * DAY_MS;
    await db.prepare(
      "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
    ).bind(userSub, SIGNUP_GRANT_UY, SIGNUP_GRANT_UY, "signup", now, exp).run();
    await db.prepare(
      "INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)"
    ).bind(userSub, now, "grant", SIGNUP_GRANT_UY, "signup", null, SIGNUP_GRANT_UY).run();
  }
  return await balanceUY(db, userSub, now);
}
```

（`getBalanceUY` 整个删掉；确认 `src/` 内无其它引用——`grep -rn getBalanceUY src/` 应为空。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/usage_store.test.js`
Expected: PASS（除尚未改的 debit 多桶/edit 用例外，本 Task 改的用例全绿；如 editCount 用例受 debit 影响，T5 处理）。

> 若 `editCount` / overdraw 用例此刻因 debit 仍是旧实现而红，属预期，T5 修复后转绿。本步只需保证 Step 1 改写的 4 个用例通过。

- [ ] **Step 5: 提交**

```bash
git add agent/src/usage_store.js agent/test/usage_store.test.js
git commit -m "feat(usage): ensureAccount issues 1y signup bucket; drop getBalanceUY"
```

---

## Task 5: debit 走桶（最快过期先扣 + 透支）

**Files:**
- Modify: `agent/src/usage_store.js`（重写 `debit`）
- Test: `agent/test/usage_store.test.js`（新增多桶扣费用例；既有 editCount/overdraw 用例应转绿）

**Interfaces:**
- Produces: `debit(db, userSub, amountUY, reason, detail, now) => Promise<void>`：从未过期桶按「最快过期在前（NULL 最后），同序按 id」递减；额度不足时把缺口压到最后一个活桶为负；无活桶则建一个 `source='overdraft'`、永不过期的负桶；最后更新 `account.spent_uy/balance_uy` 并记 `spend` 流水（`balance_uy` = 扣后活余额）。

- [ ] **Step 1: 写失败测试**（追加到 `agent/test/usage_store.test.js`）

```js
describe("debit draws soonest-expiry first", () => {
  it("spends the sooner-expiring bucket before the later/never one", async () => {
    await grantBucket(db, U, 100, "campaign:soon", 5000, 1);  // 先过期
    await grantBucket(db, U, 100, "campaign:never", null, 1); // 永不过期
    await debit(db, U, 120, "mine", { stem: "s" }, 2);
    const rows = db.prepare("SELECT source,remaining_uy FROM bucket WHERE user_sub=? ORDER BY id").bind(U).all().results;
    const soon = rows.find((r) => r.source === "campaign:soon");
    const never = rows.find((r) => r.source === "campaign:never");
    expect(soon.remaining_uy).toBe(0);    // 先扣光
    expect(never.remaining_uy).toBe(80);  // 再扣 20
  });
  it("skips expired buckets entirely", async () => {
    await grantBucket(db, U, 100, "campaign:dead", 5000, 1);  // now>5000 时已过期
    await grantBucket(db, U, 100, "campaign:live", null, 1);
    await debit(db, U, 30, "mine", { stem: "s" }, 6000);
    const live = db.prepare("SELECT remaining_uy FROM bucket WHERE user_sub=? AND source='campaign:live'").bind(U).first();
    const dead = db.prepare("SELECT remaining_uy FROM bucket WHERE user_sub=? AND source='campaign:dead'").bind(U).first();
    expect(live.remaining_uy).toBe(70);   // 只从活桶扣
    expect(dead.remaining_uy).toBe(100);  // 过期桶不动
    expect(await balanceUY(db, U, 6000)).toBe(70);
  });
  it("overdraft drives the last live bucket negative", async () => {
    await grantBucket(db, U, 50, "campaign:x", null, 1);
    await debit(db, U, 70, "mine", { stem: "s" }, 2);
    expect(await balanceUY(db, U, 2)).toBe(-20);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_store.test.js -t "soonest-expiry"`
Expected: FAIL（旧 debit 不分桶）。

- [ ] **Step 3: 重写 debit**

把 `agent/src/usage_store.js` 现有 `debit` 整体替换为：

```js
export async function debit(db, userSub, amountUY, reason, detail, now) {
  if (!amountUY || amountUY <= 0) return;
  const live = (await db.prepare(
    "SELECT id, remaining_uy FROM bucket WHERE user_sub=? AND remaining_uy > 0 AND (expires_at IS NULL OR expires_at > ?) " +
    "ORDER BY (expires_at IS NULL) ASC, expires_at ASC, id ASC"
  ).bind(userSub, now).all()).results;

  let left = amountUY;
  let lastId = null;
  const stmts = [];
  for (const b of live) {
    if (left <= 0) break;
    const take = Math.min(b.remaining_uy, left);
    stmts.push(db.prepare("UPDATE bucket SET remaining_uy = remaining_uy - ? WHERE id=?").bind(take, b.id));
    left -= take;
    lastId = b.id;
  }
  if (left > 0) {
    if (lastId != null) {
      stmts.push(db.prepare("UPDATE bucket SET remaining_uy = remaining_uy - ? WHERE id=?").bind(left, lastId));
    } else {
      // 无任何活桶（gate 一般会拦在前面，仅多步操作中途可能命中）：建一个永不过期的负桶记欠款。
      stmts.push(db.prepare(
        "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
      ).bind(userSub, 0, -left, "overdraft", now, null));
    }
  }
  if (stmts.length) await db.batch(stmts);

  const bal = await balanceUY(db, userSub, now);
  const up = db.prepare("UPDATE account SET spent_uy=spent_uy+?, balance_uy=?, updated_at=? WHERE user_sub=?")
    .bind(amountUY, bal, now, userSub);
  const led = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "spend", amountUY, reason, detail ? JSON.stringify(detail) : null, bal);
  await db.batch([up, led]);
}
```

- [ ] **Step 4: 跑整个 store 测试确认全绿**（含 editCount、overdraw、并发首触）

Run: `npx vitest run test/usage_store.test.js`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add agent/src/usage_store.js agent/test/usage_store.test.js
git commit -m "feat(usage): debit draws soonest-expiry-first with overdraft bucket"
```

---

## Task 6: 路由按桶算（balance / admin accounts）+ allAccounts

**Files:**
- Modify: `agent/src/usage_store.js`（`allAccounts` 改为按桶算活余额，签名加 `now`）
- Modify: `agent/src/index.js`（导入、余额路由、admin accounts 路由）
- Test: `agent/test/usage_routes.test.js`（余额路由用例 + admin accounts 用例）

**Interfaces:**
- Consumes: `balanceUY`, `ensureAccount`（T3/T4）
- Produces: `allAccounts(db, now) => Promise<Array<{user_sub, balance_uy(活余额), granted_uy, spent_uy, updated_at}>>`

- [ ] **Step 1: 写/改测试**（`agent/test/usage_routes.test.js`）

把首个余额用例保留（已用 `usageSql()`，新用户应仍是 500），并新增 admin accounts 用例：

```js
  it("admin accounts lists live (bucket) balance", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    // 触发一个用户的 signup（500 算力桶）
    await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/balance"),
      req("/agent/usage/balance", { token: "anon_unittesttoken_abcdefghijklmnop" }), env);
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/admin/accounts"),
      req("/agent/usage/admin/accounts", { token: "admintok" }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.accounts.length).toBe(1);
    expect(Math.round(body.accounts[0].balance_suanli)).toBe(500);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_routes.test.js -t "admin accounts lists live"`
Expected: FAIL（`allAccounts` 旧实现读 `account.balance_uy`，此处为缓存值；且签名无 `now`）。

- [ ] **Step 3: 改 allAccounts（usage_store.js）**

把现有 `allAccounts` 替换为：

```js
export async function allAccounts(db, now) {
  const r = await db.prepare(
    "SELECT a.user_sub, a.granted_uy, a.spent_uy, a.updated_at, " +
    "COALESCE((SELECT SUM(b.remaining_uy) FROM bucket b " +
    "          WHERE b.user_sub=a.user_sub AND (b.expires_at IS NULL OR b.expires_at > ?)),0) AS balance_uy " +
    "FROM account a ORDER BY a.spent_uy DESC"
  ).bind(now).all();
  return r.results;
}
```

- [ ] **Step 4: 改 index.js**

(a) 顶部导入（第 28–29 行）改为：

```js
import { editGate, claudeCostUY, uyToSuanli, uyToYuan, suanliToUY, RATE, DAY_MS, CAMPAIGN_EXPIRE_DAYS } from "./usage.js";
import { ensureAccount, debit, editCount, getLedger, grantBucket, allAccounts, balanceUY } from "./usage_store.js";
```

(b) 余额路由（现 `/agent/usage/balance` 分支）改为：

```js
  if (url.pathname === "/agent/usage/balance" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ suanli: 0, yuan: 0, granted_suanli: 0, spent_suanli: 0, degraded: true });
    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);   // 返回活余额
    const a = await env.USAGE.prepare("SELECT granted_uy,spent_uy FROM account WHERE user_sub=?").bind(scope).first();
    return J({ suanli: r1(uyToSuanli(bal)), yuan: r2(uyToYuan(bal)),
      granted_suanli: r1(uyToSuanli(a.granted_uy)), spent_suanli: r1(uyToSuanli(a.spent_uy)) });
  }
```

(c) admin accounts 路由把 `allAccounts(env.USAGE)` 改为 `allAccounts(env.USAGE, Date.now())`（其余 map 不变，`a.balance_uy` 现在已是活余额）。

- [ ] **Step 5: 跑路由测试 + 全量回归**

Run: `npx vitest run test/usage_routes.test.js`
Expected: PASS。
Run: `npm test`
Expected: 全绿（含 usage_edit / usage_mine——它们已在 T2 切到 `usageSql()`，行为保持）。若个别断言因「扣后余额快照」写法微变而红，按实际值订正断言（不得改动业务语义）。

- [ ] **Step 6: 提交**

```bash
git add agent/src/usage_store.js agent/src/index.js agent/test/usage_routes.test.js
git commit -m "feat(usage): balance + admin routes compute live bucket balance"
```

> ✅ 到此 **P1 分桶账本**完成：账本以桶为真相、惰性过期、最快过期先扣，老用户余额已回填且无感。

---

## Task 7: 活动赠送单发（grant 路由带过期 + 成本回显）

**Files:**
- Modify: `agent/src/index.js`（`/agent/usage/grant` 分支）
- Test: `agent/test/usage_routes.test.js`

**Interfaces:**
- Consumes: `grantBucket`（T3）、`RATE`、`DAY_MS`、`CAMPAIGN_EXPIRE_DAYS`、`suanliToUY`、`balanceUY`
- Produces: `POST /agent/usage/grant` body `{user_sub, suanli, reason?, expire_days?}` → 写 `campaign:<reason>` 桶（默认 90 天过期），返回 `{ok, suanli, cost_yuan, expires_at}`

- [ ] **Step 1: 写失败测试**（追加到 `agent/test/usage_routes.test.js`）

```js
  it("admin grant writes a campaign bucket with default 90d expiry and echoes cost", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant"),
      new Request("https://jianshuo.dev/agent/usage/grant", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ user_sub: "users/anon-c/", suanli: 1000, reason: "spring" }),
      }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Math.round(body.cost_yuan * 100) / 100).toBe(Math.round((1000 / 23) * 100) / 100); // ≈43.48
    const row = env.USAGE.prepare("SELECT source,expires_at FROM bucket WHERE user_sub='users/anon-c/' AND source LIKE 'campaign:%'").first();
    expect(row.source).toBe("campaign:spring");
    expect(row.expires_at).toBeGreaterThan(0); // 盖了过期日（90 天后）
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_routes.test.js -t "admin grant writes a campaign bucket"`
Expected: FAIL（旧 grant 路由用 `grant()` 无过期、不回显成本）。

- [ ] **Step 3: 改 grant 路由**（`agent/src/index.js` 的 `/agent/usage/grant` 分支整体替换）

```js
  if (url.pathname === "/agent/usage/grant" && request.method === "POST") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.user_sub || typeof b.suanli !== "number") return J({ error: "bad-request" }, 400);
    const now = Date.now();
    const days = Number.isFinite(b.expire_days) ? b.expire_days : CAMPAIGN_EXPIRE_DAYS;
    const expiresAt = now + days * DAY_MS;
    await grantBucket(env.USAGE, b.user_sub, suanliToUY(b.suanli), "campaign:" + (b.reason || "manual"), expiresAt, now);
    return J({ ok: true, suanli: b.suanli, cost_yuan: r2(b.suanli / RATE), expires_at: expiresAt });
  }
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run test/usage_routes.test.js`
Expected: PASS（含「admin grant requires FILES_TOKEN」仍 401）。

- [ ] **Step 5: 提交**

```bash
git add agent/src/index.js agent/test/usage_routes.test.js
git commit -m "feat(usage): grant route writes expiring campaign bucket + echoes cost"
```

---

## Task 8: 活动赠送批量（grant/batch 端点）

**Files:**
- Modify: `agent/src/index.js`（在 `/agent/usage/grant` 分支后新增 `/agent/usage/grant/batch` 分支）
- Test: `agent/test/usage_routes.test.js`

**Interfaces:**
- Consumes: `grantBucket`, `allAccounts`, `suanliToUY`, `RATE`, `DAY_MS`, `CAMPAIGN_EXPIRE_DAYS`
- Produces: `POST /agent/usage/grant/batch` body `{suanli, reason?, expire_days?, user_subs?: string[], all?: true}` → 给每个目标发桶；返回 `{ok, count, suanli_each, cost_yuan, expires_at}`；无目标 → 400。

- [ ] **Step 1: 写失败测试**（追加到 `agent/test/usage_routes.test.js`）

```js
  it("batch grant fans out to explicit user_subs", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant/batch"),
      new Request("https://jianshuo.dev/agent/usage/grant/batch", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ user_subs: ["users/anon-a/", "users/anon-b/"], suanli: 500, reason: "promo" }),
      }), env);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.count).toBe(2);
    const n = env.USAGE.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='campaign:promo'").first().n;
    expect(n).toBe(2);
  });
  it("batch grant requires a target set", async () => {
    const env = { USAGE: fakeD1(usageSql()), FILES_TOKEN: "admintok" };
    const r = await handleUsageRoute(new URL("https://jianshuo.dev/agent/usage/grant/batch"),
      new Request("https://jianshuo.dev/agent/usage/grant/batch", {
        method: "POST",
        headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
        body: JSON.stringify({ suanli: 500 }),
      }), env);
    expect(r.status).toBe(400);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/usage_routes.test.js -t "batch grant"`
Expected: FAIL（端点不存在 → 走到 404 分支，`status` 非预期）。

- [ ] **Step 3: 新增 batch 端点**（在 `agent/src/index.js` 的 `/agent/usage/grant` 分支之后插入）

```js
  if (url.pathname === "/agent/usage/grant/batch" && request.method === "POST") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const b = await request.json().catch(() => ({}));
    if (typeof b.suanli !== "number") return J({ error: "bad-request" }, 400);
    const now = Date.now();
    const days = Number.isFinite(b.expire_days) ? b.expire_days : CAMPAIGN_EXPIRE_DAYS;
    const expiresAt = now + days * DAY_MS;
    let targets = Array.isArray(b.user_subs) ? b.user_subs.filter((s) => typeof s === "string" && s) : null;
    if ((!targets || targets.length === 0) && b.all === true) {
      targets = (await allAccounts(env.USAGE, now)).map((a) => a.user_sub);
    }
    if (!targets || targets.length === 0) return J({ error: "bad-request", hint: "user_subs[] or all:true" }, 400);
    const source = "campaign:" + (b.reason || "manual");
    for (const u of targets) {
      await grantBucket(env.USAGE, u, suanliToUY(b.suanli), source, expiresAt, now);
    }
    return J({ ok: true, count: targets.length, suanli_each: b.suanli, cost_yuan: r2((b.suanli * targets.length) / RATE), expires_at: expiresAt });
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/usage_routes.test.js`
Expected: PASS。
Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add agent/src/index.js agent/test/usage_routes.test.js
git commit -m "feat(usage): add batch campaign grant endpoint"
```

> ✅ 到此 **P2 活动赠送**完成：单发/批量、带过期、成本回显。

---

## 部署与验证（人工，最后一步）

> 计划内代码改动全部走测试。部署是带副作用的真实操作，需王建硕确认后执行。

- [ ] **应用 D1 迁移到生产**（`agent/` 下）：
  ```bash
  npx wrangler d1 migrations apply voicedrop-usage --remote
  ```
  迁移会建 `bucket` 表并把现有 35 个账号余额回填成 `migrated` 永不过期桶。
- [ ] **对账**：迁移后调 `GET /agent/usage/admin/accounts`（带 `FILES_TOKEN`），抽查几个账号 `balance_suanli` 与迁移前一致（尤其 ae20 应仍 ≈86.7）。
- [ ] **部署 Worker**：`npx wrangler deploy`。
- [ ] **冒烟**：拿用户 token 调 `GET /agent/usage/balance` 看余额正常；admin 调一次 `POST /agent/usage/grant`（小额、短过期）验证到账与 `cost_yuan` 回显。

---

## Self-Review（计划自检结果）

**Spec 覆盖**：
- §5.1 bucket 表 → T2 ✅ ·§5.2 account 保留作统计/缓存 → T3/T4/T5 `balance_uy` 缓存 ✅ ·§5.3 ledger 不变/不加 expire 行 → 全程仅 grant/spend ✅
- §6.1 惰性余额 → T3 `balanceUY` ✅ ·§6.2 最快过期先扣 + 透支 → T5 ✅ ·§6.3 grantBucket → T3 ✅
- §7 三类来源：signup(500/1y) → T4 ✅；campaign(默认 90d) → T7/T8 ✅；subscription → **P3，不在本计划**（已注明）
- §9 活动赠送（单发 + 批量 + 成本护栏）→ T7/T8 ✅
- §10 API：balance 改造 ✅ / grant 扩展 ✅ / grant/batch ✅；`GET balance` 加 `buckets[]` 明细字段 → **未含**（spec 标「可加」，非必须；P3/前端阶段再加）
- §11 迁移回填（含负余额、零余额跳过）→ T2 ✅ ·§12.1 透支压负桶 → T5 ✅

**Placeholder 扫描**：无 TBD/TODO；每个代码步骤均给出完整代码与确切命令/预期。

**类型/命名一致性**：`balanceUY(db,userSub,now)`、`grantBucket(db,userSub,amountUY,source,expiresAt,now)`、`debit(db,userSub,amountUY,reason,detail,now)`、`allAccounts(db,now)` 在所有 Task 中签名一致；`source` 取值 `signup|campaign:<reason>|migrated|overdraft` 全程统一；index.js 导入与调用名一致（`grantBucket`/`balanceUY`/`allAccounts`）。

**已知取舍**（已在 spec §12 记录，非缺陷）：透支负桶若恰好是会过期的桶，过期后这点欠款消失——金额封顶一次操作、概率极低，接受。
