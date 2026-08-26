# 微信委托代扣上线清单

本功能在 `feat/wechat-pay` 分支中。它与 iOS 的 StoreKit 订阅共用 `bucket` / `ledger` 发放算力，但微信签约和订单独立保存在 `wechat_sub`、`wechat_txn`；不会扫描 R2。

## 上线前的商户侧准备

1. 在微信支付商户平台将签约入口所用的 AppID 绑定到商户号，并申请获批「委托代扣 / 自动续费」产品和月度 `plan_id`。
2. 确认商户获批的委托代扣 API 是 XML V2 接口，并取得其**准确的扣费申请 URL**。本代码不猜测 URL：把该 URL 配到 `WECHAT_PAY_APPLY_URL`。
3. 在该模板/产品的通知配置中使用下面三个公网 HTTPS 地址；签约发起接口也会把它们返回给客户端：

   - 签约结果：`https://jianshuo.dev/agent/wechat-pay/contract-notify`
   - 支付结果：`https://jianshuo.dev/agent/wechat-pay/pay-notify`
   - 解约结果：`https://jianshuo.dev/agent/wechat-pay/cancel-notify`

4. iOS/客户端先调用 `POST /agent/wechat-pay/contract`（带现有 Bearer token），取得 `contract_code`、`plan_id` 及三个回调 URL；将 `contract_code` 作为商户侧签约标识传给已获批的微信签约 SDK/API。客户端不得自行传 `plan_id` 或回调 URL。

这份 Worker 实现的是微信 V2 XML/MD5 委托代扣通道。如果商户最终获批的是 APIv3/平台证书签名通道，不能混用这套密钥；应在接入前补一个 v3 adapter 并在微信沙箱验证，不能仅替换环境变量上线。

## D1 迁移与部署

从后端仓库执行。`wrangler deploy` **不会**自动运行 D1 SQL 迁移，必须先执行迁移：

```sh
cd ~/code/jianshuo.dev/agent
npx wrangler d1 migrations apply voicedrop-usage --remote
```

确认输出已应用 `0005_wechat.sql` 后，再部署 Worker：

```sh
npm test
npx wrangler deploy
```

当前 `wrangler.jsonc` 已有 `*/5 * * * *` Cron；代码复用它来扫描 D1 到期签约和重试失败订单，不需要在 Cloudflare 控制台再建 Cron 或 Durable Object Alarm。

## Worker Secrets

以下值不要写进 `wrangler.jsonc` 或 Git。逐个通过 Wrangler 填入生产 Worker：

```sh
npx wrangler secret put WECHAT_PAY_MCH_ID
npx wrangler secret put WECHAT_PAY_APP_ID
npx wrangler secret put WECHAT_PAY_PLAN_ID
npx wrangler secret put WECHAT_PAY_API_V2_KEY
npx wrangler secret put WECHAT_PAY_APPLY_URL
npx wrangler secret put WECHAT_PAY_PUBLIC_ORIGIN
```

可选金额（默认 ¥19.90）：

```sh
npx wrangler secret put WECHAT_PAY_AMOUNT_FEN
```

`WECHAT_PAY_API_V2_KEY` 是 XML 请求和回调验签的 API 密钥，不是 APIv3 密钥；两者不可互换。

## 自动续费与数据行为

- `wechat_sub`：每一份协议一行，`contract_code` 在发起签约前保存，签约回调补入微信的 `contract_id`。解约行不会删除，用户随后重新订阅会创建新的协议行；仍有 `active` 协议时接口返回 `409 already-subscribed`，避免双扣。
- `wechat_txn`：每个自然月一期、一个稳定 `out_trade_no`；网络失败在同一订单号上指数退避重试，支付成功回调重复到达也只发一次钱。只保存微信订单号、请求/回调时间、重试次数及最后错误码等当前快照。
- `wechat_event`：不可变审计日志，记录每次签约、扣费申请、微信回调、失败、结算及解约的协议号、订单号、状态迁移、微信错误文本和已脱敏载荷。排错时按 `contract_code` 或 `out_trade_no` 查询此表。
- 用户的 `/agent/wechat-pay/status` 不返回微信原始错误码或错误文本，只返回通用 `payment_issue: "payment-failed"`；原始错误只保存在受控的 D1 审计数据中。
- 签约成功后 Cron 立即发起首期扣费；以后在本周期结束前 **24 小时**发起下一期委托扣费申请。
- 仅收到验签通过且金额匹配的微信成功回调，才发 200 算力。桶到期时间是该自然月周期结束加 **6 小时**宽限。
- 微信解约回调将协议设为 `cancelled` 并清空 `next_charge_at`，Cron 不会再为它建单。

## 上线验证顺序

1. 用微信支付沙箱/测试商户完成一次签约，确认 `wechat_sub` 从 `pending` 变为 `active`，且已保存 `contract_id`。
2. 观察首期 `wechat_txn` 由 `pending` 变为 `charging`；同一个 `out_trade_no` 即使 Cron 多次执行也不得重复。
3. 发送/等待微信成功回调，确认 `wechat_txn.status='paid'`、`bucket_id` 非空，账本有一条 `reason='subscription'` 且 detail 内有 `out_trade_no`。
4. 重放同一支付通知，确认没有新增第二个订阅桶。
5. 在微信侧解约，确认 `wechat_sub.status='cancelled'`，且之后不再产生新订单。
6. 用同一个用户再次签约，确认保留旧的 `cancelled` 行、创建新的 `active` 行，且状态接口返回新协议。

生产支付接入涉及商户资金。首次上线应先在沙箱完整走完上述 5 步，再把真实商户号和 API URL 写入生产 Secret。
