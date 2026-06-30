# VoiceDrop 订阅与算力分桶系统设计

> 日期：2026-06-30 ·状态：待评审 ·作者：王建硕 + Claude
> 影响范围：`jianshuo.dev/agent`（算力账本、订阅接入）+ VoiceDrop iOS App（StoreKit）

## 1. 背景与目标

VoiceDrop 当前用「单一余额钱包」记账：`account.balance_uy` 一个数字只增只减、永不过期、可透支。新用户一次性赠 500 算力。没有任何付费入口（App 无 StoreKit，后端无收据校验）。

要做两件事：

1. **苹果内购包月订阅**：纯订阅制，不做按量买断充值。`¥19.9/月 → 200 算力`，每月清零。
2. **活动赠送**：能给指定用户/批量用户发放大量算力，**3 个月后过期**。

这两件事都要求账本支持「带过期日的算力」，而现有单一余额模型做不到。本设计把账本从「单一余额」升级为「分桶记账」，并在其上接入苹果订阅与活动赠送。

### 成本基准（贯穿全文）

代码里 `RATE = 23 算力 = ¥1` 是**王建硕的真实成本**（Claude API + 火山 ASR），即 **1 算力 ≈ ¥0.0435**。所有定价/赠送决策都用这个单价折算成本。

## 2. 已拍板的关键决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 计费模型 | 纯订阅，苹果自动续订；不做买断式充值 |
| D2 | 包月套餐 | `¥19.9/月 → 200 算力`，售价比例 **¥1 = 10 算力**（成本价 ¥1=23 的 2.3 倍）|
| D3 | 套餐档位 | **单档**上线；上档（如 ¥49.9）留待数据决定 |
| D4 | 包月额度过期 | **本月底/计费周期末过期** → 等价「每月清零」，不滚存 |
| D5 | 注册赠送 | 维持 **500 算力**，过期 **1 年** |
| D6 | 活动赠送 | 每次活动定量；过期 **3 个月** |
| D7 | 账本模型 | **分桶记账**，每笔到账一个带过期日的桶 |
| D8 | 过期实现 | **惰性**（`expires_at > now` 过滤），无定时任务 |
| D9 | 过期展示 | **不展示**，过期的桶静默从余额消失，不写过期流水 |

## 3. 单位经济学（为什么是 200 / ¥19.9）

苹果抽成后到手：小企业计划（年收入 <100 万美元，符合）抽 15% → **¥16.92**；普通抽 30% → ¥13.93。

200 算力满额成本 = 200 ÷ 23 = **¥8.70**。

| 苹果抽成 | 到手 | 用户榨干 200 的成本 | 最坏单用户盈亏 |
|---|--:|--:|--:|
| 15% | ¥16.92 | ¥8.70 | **赚 ¥8.2** ✅ |
| 30% | ¥13.93 | ¥8.70 | 赚 ¥5.2 ✅ |

**结论：因月清零、无溢出，单用户用量封顶 200，无论轻重都正毛利。下行风险归零。** 代价是 200 算力约等于「10 篇普通短文 / 5 篇带编辑 / 1–2 篇长录音重编辑」，重度用户会较快撞墙——这正是未来加上档的钩子。

**真正的成本闸门是活动赠送**：每 1 算力 = ¥0.0435 真实成本，送 1000 算力若用光 = ¥43.5。订阅这边已被月清零摁死，活动赠送要按此单价控量。

## 4. 架构总览

```
                        ┌─────────────────────────────┐
   App Store ──webhook──▶  App Store Server Notif. V2  │  (Phase 3)
   (续费/退款)            │  /agent/iap/notifications   │
                        └──────────────┬──────────────┘
                                       │ 幂等 grant(200, 'subscription', 周期末)
   iOS App (StoreKit2) ─purchase──┐    ▼
   appAccountToken=user_sub       │  ┌───────────────────────────────────┐
                                  └─▶│  算力分桶账本 (D1)                  │
   挖矿/编辑/ASR ──debit──────────────▶│  bucket 表 = 唯一真相              │  (Phase 1)
                                     │  余额 = Σ未过期桶 remaining        │
   管理员活动 ──grant(N,3mo)──────────▶│  扣费 = 最快过期先扣               │  (Phase 2)
                                     └───────────────────────────────────┘
```

四个相对独立、可分期交付的单元：**① 分桶账本（核心，向后兼容）→ ② 活动赠送工具 → ③ 订阅服务端发放 → ④ iOS 客户端 + 付费墙**。

## 5. 数据模型

### 5.1 新增 `bucket` 表（算力唯一真相）

```sql
-- migrations/0002_buckets.sql
CREATE TABLE IF NOT EXISTS bucket (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub     TEXT NOT NULL,
  amount_uy    INTEGER NOT NULL,        -- 到账原始额度（微元）
  remaining_uy INTEGER NOT NULL,        -- 剩余，扣费时递减；透支可为负
  source       TEXT NOT NULL,           -- 'signup'|'subscription'|'campaign:<id>'|'migrated'
  created_at   INTEGER NOT NULL,        -- ms epoch
  expires_at   INTEGER                  -- ms epoch；NULL = 永不过期
);
CREATE INDEX IF NOT EXISTS idx_bucket_user_exp ON bucket(user_sub, expires_at);
```

### 5.2 现有 `account` 表：保留作生命周期统计

`account` 行保留，但 `balance_uy` **不再是真相**（余额改为按桶实时算）。`granted_uy` / `spent_uy` 继续累加用于统计与 admin 面板。`balance_uy` 列可保留为「最近一次写操作算出的缓存值」，仅供快速展示，**不参与扣费判定**。

### 5.3 `ledger` 表：保持不变（仅作审计/展示流水）

继续 append-only 记 `grant` / `spend`。**不新增 `expire` 类型**（D9）。`balance_uy` 快照列写入「该笔之后的按桶余额」。

### 5.4 新增 `iap_txn` 表（订阅幂等，Phase 3）

```sql
-- migrations/0003_iap.sql
CREATE TABLE IF NOT EXISTS iap_txn (
  transaction_id   TEXT PRIMARY KEY,    -- 苹果每次续费唯一 id
  original_txn_id  TEXT,                -- 同一订阅链固定，用于映射用户
  user_sub         TEXT NOT NULL,
  product_id       TEXT,
  expires_date     INTEGER,             -- 苹果给的本周期到期时间
  bucket_id        INTEGER,             -- 本次发放的桶
  processed_at     INTEGER NOT NULL
);
```

## 6. 余额与扣费逻辑

### 6.1 余额（惰性过期）

```
balanceUY(user, now) =
  SELECT COALESCE(SUM(remaining_uy), 0) FROM bucket
   WHERE user_sub = user
     AND (expires_at IS NULL OR expires_at > now)
```

过期 = 一个 `WHERE` 条件。无需扫表、无需定时任务、无需清理，精确到毫秒、自愈。

### 6.2 扣费（最快过期先扣）

```
debit(user, amountUY, reason, detail, now):
  live = SELECT * FROM bucket
          WHERE user_sub=user AND remaining_uy > 0
            AND (expires_at IS NULL OR expires_at > now)
          ORDER BY (expires_at IS NULL) ASC, expires_at ASC   -- 最快过期在前，NULL 最后
  left = amountUY
  for b in live:
    take = min(b.remaining_uy, left)
    UPDATE bucket SET remaining_uy = remaining_uy - take WHERE id=b.id
    left -= take
    if left == 0: break
  if left > 0:                          -- 透支（见 §12.1）：把缺口压到最后一个 live 桶为负
    UPDATE bucket SET remaining_uy = remaining_uy - left WHERE id = (last live bucket id)
    # 若该用户没有任何 live 桶，则建一个 source='overdraft'、expires_at=NULL 的负桶
  UPDATE account SET spent_uy = spent_uy + amountUY, balance_uy = balanceUY(user,now), updated_at=now
  INSERT ledger(kind='spend', amount_uy=amountUY, reason, detail, balance_uy=balanceUY(user,now))
```

「最快过期先扣」保证：用户不平白损失即将过期的额度；活动算力（3 个月）会先于注册赠送（1 年）被用掉，正是办活动想要的。

### 6.3 发放

```
grantBucket(user, amountUY, source, expires_at, now):
  INSERT bucket(user, amountUY, amountUY, source, now, expires_at)
  UPDATE account SET granted_uy = granted_uy + amountUY, balance_uy = balanceUY(user,now), updated_at=now
  INSERT ledger(kind='grant', amount_uy=amountUY, reason=source, balance_uy=balanceUY(user,now))
```

## 7. 三类算力来源与过期策略

| 来源 | `source` | 额度 | `expires_at` | 触发点 |
|---|---|---|---|---|
| 注册赠送 | `signup` | 500 算力 | `created_at + 365 天` | 首次 `ensureAccount` |
| 包月续费 | `subscription` | 200 算力 | **苹果给的周期到期时间** | 每次苹果续费通知 |
| 活动赠送 | `campaign:<id>` | 每次活动定 | `now + 90 天`（可被 admin 覆盖）| 管理员调用 |

**月清零如何自然实现**：每次续费发的 200 桶，`expires_at` = 苹果返回的本周期到期时间。下个周期续费到账时，上一桶恰好过期 → 余额里永远只有「当月那 200」→ 等价月清零，无需任何额外逻辑（D4）。

## 8. 苹果订阅接入（Phase 3 + 4）

### 8.1 客户端（iOS，StoreKit 2）

- 配置一个 **auto-renewable subscription** 产品（如 `com.voicedrop.sub.monthly`，¥19.9）。
- 购买时设置 `Product.PurchaseOption.appAccountToken(uuid)`，其中 uuid 由后端按 `user_sub` 派生/登记，作为**苹果交易 ↔ VoiceDrop 用户**的映射键。
- 监听 `Transaction.updates`，把签名交易（JWS）回传后端校验；UI 显示订阅状态与「本月剩余算力」。
- 付费墙：余额不足 / 撞墙时引导订阅。

### 8.2 服务端（`/agent/iap/*`）

两条路都要，互为兜底：

1. **App Store Server Notifications V2**（推荐主路）：在 App Store Connect 配 webhook → `/agent/iap/notifications`。收到 `SUBSCRIBED` / `DID_RENEW` → 发放；`REFUND` / `REVOKE` → 回收；`DID_CHANGE_RENEWAL_STATUS` → 记状态。
2. **客户端回传校验**（兜底）：`POST /agent/iap/verify`，body 为客户端拿到的 JWS 交易，后端校验后发放。

### 8.3 发放逻辑（幂等）

```
onAppleTransaction(jws, now):
  payload = verifyJWS(jws, AppleRootCerts)         # 验签 + 解码
  txnId   = payload.transactionId
  if EXISTS iap_txn[txnId]: return                  # 幂等：同一续费只发一次
  user    = mapUser(payload.appAccountToken | payload.originalTransactionId)
  if payload.type == 'Auto-Renewable Subscription' and active:
     b = grantBucket(user, suanliToUY(200), 'subscription', payload.expiresDate, now)
     INSERT iap_txn(txnId, payload.originalTransactionId, user, payload.productId, payload.expiresDate, b.id, now)
```

幂等键 = `transaction_id`（苹果每周期唯一）。验签用苹果根证书校验 JWS，杜绝伪造收据。

## 9. 活动赠送（Phase 2，管理员工具）

复用已有的 `POST /agent/usage/grant`（当前仅 admin 可调），扩展为写桶 + 带过期：

```
POST /agent/usage/grant        Authorization: Bearer <FILES_TOKEN>
body: {
  user_sub: "users/anon-.../",   // 单用户；批量见下
  suanli:   1000,
  reason:   "spring-2026",        // → source = 'campaign:spring-2026'
  expire_days: 90                 // 可选，默认 90
}
```

- 批量：可加 `POST /agent/usage/grant/batch`，body 接受 `user_subs: [...]` 或 `all: true`（全量普发，需二次确认）。
- 每次发放写一个 `source='campaign:<reason>'`、`expires_at = now + expire_days*86400e3` 的桶。
- **成本护栏**：返回体回显本次总成本（`Σsuanli ÷ 23` 元），admin 面板（`voicedrop/admin/usage.html`）展示「活动累计赠送成本」。

## 10. API 变更汇总

| 端点 | 变更 |
|---|---|
| `GET /agent/usage/balance` | 余额改为按桶实时算；返回体可加 `buckets:[{suanli,expires_at,source}]` 让 App 展示「200 算力将于 X 月 X 日重置」|
| `GET /agent/usage/ledger` | 不变（不加 expire 行）|
| `POST /agent/usage/grant` | 扩展：写桶 + `expire_days`，source 记 `campaign:<reason>` |
| `POST /agent/usage/grant/batch` | 新增（批量活动赠送）|
| `POST /agent/iap/notifications` | 新增（App Store Server Notifications V2）|
| `POST /agent/iap/verify` | 新增（客户端回传校验兜底）|

`debit` / `ensureAccount` / `grant` / `editGate` / `gateDecision`（`usage_store.js` + `usage.js`）内部改为走桶，对外签名尽量不变。

## 11. 迁移与向后兼容

```sql
-- 0002_buckets.sql 内，建表后回填：
-- 把每个账号当前余额迁成一个「永不过期」的桶，避免给老用户的既有余额追加过期日造成意外清零。
INSERT INTO bucket (user_sub, amount_uy, remaining_uy, source, created_at, expires_at)
SELECT user_sub, balance_uy, balance_uy, 'migrated', updated_at, NULL
FROM account WHERE balance_uy <> 0;
```

- 既有余额（含负数透支账号，如 ae20 当前 +86.7）原样迁成单桶，`expires_at=NULL`。
- 迁移后老逻辑读 `balance_uy` 仍能跑（值仍在），切换到按桶算后两者短期内应一致；灰度期可双算对账。
- 新注册起按 §7 发 1 年期 signup 桶。

## 12. 边界情况

1. **透支**：现系统允许单次操作把余额压到略负（gate 只在操作前查 `balance>0`）。分桶下，缺口压到最后一个 live 桶为负（§6.2），与现状等价、幅度封顶一次操作。极少数情况下负桶过期会让这点欠款消失，金额微小可接受。
2. **续费空窗/时钟偏差**：上一桶按苹果到期时间过期，新桶到账可能差几秒。可给 subscription 桶过期加几小时 grace，或以新桶到账为准；不影响月清零本质。
3. **退款/撤销**：`REFUND`/`REVOKE` 通知 → 找到 `iap_txn.bucket_id`，把该桶 `remaining_uy` 置 0（或删桶）。幂等。
4. **宽限期/账单重试**（苹果 billing retry）：续费失败进入 grace 时**不发新桶**，旧桶到期即清零，符合「没付钱就没额度」。
5. **并发首次触达**：沿用现有 `INSERT OR IGNORE` 思路保证 signup 桶只发一次。
6. **退订**：用户取消 → 不再有续费通知 → 最后一桶到期自动清零，无需特殊处理。

## 13. 不做（YAGNI）

- ❌ 按量买断充值（用户明确不要）。
- ❌ 滚存 / 跨月累积包月额度（D4 月清零）。
- ❌ 过期展示行 / 过期定时任务（D8/D9）。
- ❌ 多档位（先单档，D3）。
- ❌ 安卓 / 网页支付（当前只苹果）。
- ❌ 算力转赠、家庭共享、退款自助。

## 14. 实施分期

| 阶段 | 内容 | 依赖 | 可独立上线 |
|---|---|---|---|
| **P1 分桶账本** | `bucket` 表 + migration + 余额/扣费/发放改造 + 双算对账 | — | ✅（行为对老用户无感）|
| **P2 活动赠送** | `grant` 扩展过期 + 批量端点 + admin 成本展示 | P1 | ✅ |
| **P3 订阅服务端** | `iap_txn` + 通知/校验端点 + 幂等月发放 | P1 | ✅（先用 sandbox 验）|
| **P4 iOS 客户端** | StoreKit2 产品 + appAccountToken 映射 + 付费墙 UI | P3 | 最后 |

P1 是地基且向后兼容，可先合先上；P2 紧随（你眼下就想搞活动）；P3/P4 是订阅闭环。

## 15. 验收与测试

- **单元**：余额=Σ未过期桶；扣费最快过期先扣；过期桶不计入；透支压负桶；grant 幂等（iap_txn）。
- **过期时序**：构造「今天过期」「明天过期」「永不过期」三桶，断言余额与扣费顺序随 `now` 推移正确。
- **迁移对账**：迁移后对全部 35 个账号，按桶余额 == 旧 `balance_uy`。
- **订阅闭环**：苹果 sandbox 走 购买→续费→退订→退款，断言桶的发放/到期/回收。
- **经济回归**：固定 200 算力满额成本 ¥8.70，断言定价常量未漂移。

---

### 附：定价/常量集中处（`usage.js`）

```js
export const SALE_RATE        = 10;                 // 售价：¥1 = 10 算力（成本 RATE=23）
export const SUB_PRICE_RMB    = 19.9;               // 包月价
export const SUB_GRANT_SUANLI = 200;                // 包月发放
export const SIGNUP_GRANT_SUANLI = 500;             // 注册赠送
export const SIGNUP_EXPIRE_DAYS  = 365;             // 注册赠送 1 年
export const CAMPAIGN_EXPIRE_DAYS = 90;             // 活动赠送默认 3 个月
```
