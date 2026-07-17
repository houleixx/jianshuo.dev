# VoiceDrop 订阅 P3（服务端）+ P4（iOS）实施计划

> 日期：2026-07-17 · spec = `../specs/2026-06-30-voicedrop-subscription-credits-design.md`
> P1 分桶账本 / P2 活动赠送已上线；本计划落地 P3 + P4：¥19.9/月 → 每月 200 算力，月清零。

## 与 spec 的两处实现偏差（有意）

1. **验证不走本地 JWS 链验签，走 App Store Server API**：客户端只回传 `transaction_id`，
   服务端拿它去 `api.storekit.itunes.apple.com`（404 → sandbox 域名兜底）查权威交易信息。
   信任源 = 对苹果的 TLS 连接，不需要在 Worker 里自实现 x509 链校验（几百行易错代码）。
   ASN 通知同理：decode signedPayload 只为取 transactionId，**入账前一律回查苹果**，
   伪造的通知在回查这一步自然死掉。需要 3 个 worker secret：`ASC_API_KEY_ID` /
   `ASC_API_ISSUER_ID` / `ASC_API_KEY_CONTENT`（base64 p8，与 fastlane/GitHub 同一把 key）。
2. **不用 appAccountToken**：绑定 = 首个带用户 token 成功 claim 的账号
   （`iap_sub.original_txn_id → user_sub`，first-claim-wins）；换账号 claim 同一订阅 → 409。
   ASN 续费通知无用户上下文，靠这张映射表找到人；映射还没建立时（用户买完从未 claim 成功）
   通知侧跳过，客户端下次启动 claim 兜底。

## P3 服务端（jianshuo.dev repo）

- `agent/migrations/0004_iap.sql`：`iap_txn`（transaction_id PK，幂等键；含 bucket_id 供退款回收）
  + `iap_sub`（original_txn_id PK → user_sub 绑定 + 状态缓存）。
- `agent/src/iap.js`：appleJWT（ES256, WebCrypto）、fetchAppleTransaction（prod→sandbox）、
  handleIapRoute：
  - `POST /agent/iap/claim` `{transaction_id}`（resolveScope 鉴权）：回查苹果 → 校验 bundleId
    + productId → 绑定检查 → `INSERT OR IGNORE iap_txn` 幂等 → 未过期/未撤销才
    `grantBucket(sub, 200算力, 'subscription', expiresDate+6h宽限)`。
  - `POST /agent/iap/notifications`（ASN V2，公开）：decode → 回查 → SUBSCRIBED/DID_RENEW
    走同一 processTransaction；REFUND/REVOKE → 把 iap_txn.bucket_id 的 remaining_uy 置 0。
    永远 200（防苹果重试风暴），内部错误 500 让苹果重试。
  - `GET /agent/iap/status`：当前用户订阅状态（active/expires_date/product_id）。
- 常量进 `usage.js`：`SUB_PRODUCT_MONTHLY = "com.wangjianshuo.VoiceDrop.sub.monthly"`、
  `SUB_BUCKET_GRACE_MS = 6h`（续费空窗宽限，spec §12.2）。
- 测试 `agent/test/iap.test.js`：claim 幂等 / 绑定冲突 409 / 过期不发 / 通知续费入账 /
  退款回收 / secrets 缺失 503 / sandbox 兜底 / JWT 形状。
- 部署：migration apply --remote → secrets put ×3 → 合 origin/main → wrangler deploy → 冒烟。

## P4 iOS（voicedrop repo）

- `StoreService.swift`：StoreKit 2。加载产品 / purchase / Transaction.updates 监听 /
  启动时 currentEntitlements 逐条 claim（服务端幂等，续费月月自动到账的客户端兜底路）。
  claim 用 AuthStore.bearer（算力记在 anon scope，与 usage 同一口径）。
- `UsageView` 顶部订阅卡：未订阅 → ¥19.9/月 购买按钮 + 「每月自动充入 200 算力，当月有效」；
  已订阅 → 状态 + 到期日 + 管理订阅（showManageSubscriptions）+ 恢复购买。
  审核要求的自动续期条款 + 隐私/协议链接。
- 新文件过 xcodegen；单测覆盖 claim 请求构造与状态映射的纯逻辑部分。

## 上线后的手工步骤（App Store Connect，代码做不了）

1. 功能 → App 内购买项目 → 创建**自动续期订阅**：产品 ID
   `com.wangjianshuo.VoiceDrop.sub.monthly`，订阅群组新建（如「VoiceDrop 会员」），
   时长 1 个月，价格选最接近 ¥19.9 的价位点，中文名「VoiceDrop 包月」+ 描述。
2. App 信息 → App Store 服务器通知 → V2，生产 + 沙盒 URL 都填
   `https://jianshuo.dev/agent/iap/notifications`。
3. 订阅随下一个 App 版本一起提审（首个订阅需和版本一起提交，附审核备注）。
