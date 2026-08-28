# 微信委托代扣上线清单

本功能在 `feat/wechat-pay` 分支中。它与 iOS 的 StoreKit 订阅共用 `bucket` / `ledger` 发放算力，但微信签约和订单独立保存在 `wechat_sub`、`wechat_txn`；不会扫描 R2。

## 上线前的商户侧准备

1. 在微信支付商户平台将签约入口所用的 AppID 绑定到商户号，并申请获批「委托代扣 / 自动续费」产品和月度 `plan_id`。
2. 确认商户获批的是 XML V2 委托代扣接口。本代码固定调用微信官方申请扣款地址 `https://api.mch.weixin.qq.com/pay/pappayapply`。
3. 在该模板/产品的通知配置中使用下面三个公网 HTTPS 地址：

   - 签约结果：`https://voicedrop.cn/agent/wechat-pay/contract-notify`
   - 支付结果：`https://voicedrop.cn/agent/wechat-pay/pay-notify`
   - 解约结果：`https://voicedrop.cn/agent/wechat-pay/cancel-notify`

4. Android 先调用 `POST /agent/wechat-pay/contract`（带现有 Bearer token）。Worker 在服务端调用微信 V2 `papay/preentrustweb`、验签并保存会话；Android 只会收到 `contract_code`、`pre_entrustweb_id`、可选的 `wechat_mini_program_username` / `wechat_mini_program_path` 与 `expires_at`。不得把 `plan_id`、商户号、回调 URL、签名或任何密钥下发给客户端。
5. Android 优先用微信 OpenSDK 的 `WXLaunchMiniProgram` 携带服务端原样返回的 `username` 和 `path` 拉起签约；老模板未返回小程序字段时，改用 `WXOpenBusinessWebview`（`businessType=12`，只传 `pre_entrustweb_id`）。App 回来后不要相信本地结果，轮询 `GET /agent/wechat-pay/status`，以微信签约/扣款异步回调为准。
6. Android 已签约用户可调用 `POST /agent/wechat-pay/cancel` 解除自动续费。接口用当前登录用户对应的 `contract_id` 在服务端调用微信 V2 `papay/deletecontract`；客户端不接触协议号、商户号或签名。须先二次确认，并明确告知用户：已付款的当期算力仍有效至 `expires_date`，仅停止之后的自动扣款。重复请求安全地返回已解除状态。

6. iOS 与 Android 的订阅入口在展示购买/签约按钮前，都调用 `GET /agent/subscription/status`。它只返回一个安全摘要 `{active, provider, expires_date}`；有有效 iOS 订阅时，`POST /agent/wechat-pay/contract` 会返回 `409 already-subscribed`，不会创建微信待签约记录。当前只拦截“iOS 已订阅后再开微信”的 Android 正常路径；如果用户绕过 iOS 界面在 App Store 成交，现阶段仍按原 iOS 流程发放算力。

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

`wrangler.jsonc` 配置了独立的 `*/15 * * * *` Cron 扫描 D1 到期协议和重试失败订单；原有 `*/5 * * * *` 只继续负责探活/报警。不需要在 Cloudflare 控制台再手动建 Cron 或 Durable Object Alarm。

## Worker Secrets

以下值不要写进 `wrangler.jsonc` 或 Git。逐个通过 Wrangler 填入生产 Worker：

```sh
npx wrangler secret put WECHAT_PAY_MCH_ID
npx wrangler secret put WECHAT_PAY_APP_ID
npx wrangler secret put WECHAT_PAY_PLAN_ID
npx wrangler secret put WECHAT_PAY_API_V2_KEY
npx wrangler secret put WECHAT_PAY_CALLBACK_BASE_URL
```

可选：签约页显示的用户账户名称（默认 `VoiceDrop 包月算力`，不能含 emoji）：

```sh
npx wrangler secret put WECHAT_PAY_CONTRACT_DISPLAY_ACCOUNT
```

预签约接口默认使用微信官方 V2 地址 `https://api.mch.weixin.qq.com/papay/preentrustweb`；只有沙箱或微信书面要求使用其他地址时，才设置 `WECHAT_PAY_PRECONTRACT_URL`。

可选金额（默认 ¥19.90）：

```sh
npx wrangler secret put WECHAT_PAY_AMOUNT_FEN
```

`WECHAT_PAY_API_V2_KEY` 是 XML 请求和回调验签的 API 密钥，不是 APIv3 密钥；两者不可互换。

## 微信售卖开关

微信支付售卖开关与 iOS 的 `config/iap.json` 一致：私有 R2 Bucket 中的 `config/wechat-pay.json` 必须明确写入 `{"enabled":true}` 才开放；文件不存在、读取异常或 JSON 损坏都保持关闭。

```json
{"enabled":false}
```

将值改为 `{"enabled":false}` 或删除文件即可关闭 Android 的微信订阅入口和新的服务端签约。该开关不影响已签约用户完成待签约会话、自动续费、微信回调或订阅状态查询。

## 自动续费与数据行为

- `wechat_sub`：每一份协议一行，`contract_code` 在发起预签约前保存；`pre_entrustweb_id` 与小程序拉起参数只通过本次 HTTPS 响应给已认证 Android，**不写入 D1，也不写入审计载荷**。签约回调补入微信的 `contract_id`。解约行不会删除，用户随后重新订阅会创建新的协议行；仍有 `active` 协议时接口返回 `409 already-subscribed`，避免双扣。若旧的已付款周期尚未结束，新的协议只完成签约，`period_*` 保持为空，复用 `next_charge_at` 记录首期衔接申请时间。
- `wechat_txn`：每个自然月一期、一个稳定 `out_trade_no`；网络失败在同一订单号上指数退避重试，支付成功回调重复到达也只发一次钱。只保存微信订单号、请求/回调时间、重试次数及最后错误码等当前快照。
- `wechat_event`：不可变审计日志，记录每次签约、扣费申请、微信回调、失败、结算及解约的协议号、订单号、状态迁移、微信错误文本和已脱敏载荷。排错时按 `contract_code` 或 `out_trade_no` 查询此表。
- 用户的 `/agent/wechat-pay/status` 不返回微信原始错误码或错误文本，只返回通用 `payment_issue: "payment-failed"`；原始错误只保存在受控的 D1 审计数据中。
- 同一用户重复请求会复用同一份待签约的 `contract_code`，但每次都由微信创建新的临时预签约会话；会话只存在于 Android 的本次响应中。签约成功回调会通过 Worker `waitUntil` **立即发起首期扣费申请**；15 分钟 Cron 只负责首期失败重试和以后在本周期结束前 **24 小时**发起的续期扣费。
- Cron 在创建或重试任何后续扣款前，先调用微信 V2 `papay/querycontract` 查询协议。查询结果为“未签约”时，即使解约回调丢失，也会将本地协议标为 `cancelled`、停止未申请订单；查询异常或“签约进行中”时宁可延后，不会盲目发起扣款。已送往微信的 `charging` 订单保留等待其最终支付回调；若它随后成功，仅发放这笔已付款的本期算力，协议仍保持 `cancelled` 且不会恢复下次扣款。
- 仅收到验签通过且金额匹配的微信成功回调，才发 200 算力。桶到期时间严格为该自然月周期结束，不额外增加宽限。
- 微信解约回调将协议设为 `cancelled` 并清空 `next_charge_at`，Cron 不会再为它建单。
- App 内解约与微信侧解约使用同一套状态收敛：微信 `papay/deletecontract` 成功后立即将本地协议设为 `cancelled`，并停止 `pending/failed` 订单；已被微信受理的 `charging` 订单保留等待最终回调。`status.active` 表示当期权益是否仍有效，`can_cancel` 才表示自动续费是否仍可解除。
- 取消后、旧周期尚未到期又重新签约时，新的首期计划为 `next_charge_at = 旧 period_end_at - 24h`。计划时间未到时，签约回调**不立即申请首期扣款**，由 Cron 到点执行；协议的 `period_end_at` 为空时，Cron 以 `next_charge_at + 24h` 作为首期订单的 `period_start_at`。若用户重签时已经不足 24 小时，则签约回调立即申请首期扣款，成功后可能短暂与旧周期算力重叠。无论何时实际扣款，订单周期都从旧周期端点开始，保证后续自然月首尾衔接。

## 上线验证顺序

1. Android 调用 `POST /agent/wechat-pay/contract`，确认响应只含一次性预签约会话与 Android 拉起参数，没有商户号、模板、回调地址、签名或密钥；用微信支付沙箱/测试商户完成一次签约，确认 `wechat_sub` 从 `pending` 变为 `active`，且已保存 `contract_id`。
2. 观察首期 `wechat_txn` 由 `pending` 变为 `charging`；同一个 `out_trade_no` 即使 Cron 多次执行也不得重复。
3. 发送/等待微信成功回调，确认 `wechat_txn.status='paid'`、`bucket_id` 非空，账本有一条 `reason='subscription'` 且 detail 内有 `out_trade_no`。
4. 重放同一支付通知，确认没有新增第二个订阅桶。
5. 在 App 内点击“解除自动续费”（或在微信侧解约），确认 `wechat_sub.status='cancelled'`、`next_charge_at` 为空，且之后不再产生新订单；若本期已经支付，仍可使用算力直到 `expires_date`。
6. 用同一个用户再次签约，确认保留旧的 `cancelled` 行、创建新的 `active` 行，且状态接口返回新协议。

生产支付接入涉及商户资金。首次上线应先在沙箱完整走完上述 5 步，再把真实商户号和 API URL 写入生产 Secret。
