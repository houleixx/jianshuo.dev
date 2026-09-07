# 微信自动续费：部署与恢复

本实现位于后端 `feat/wechat-pay`。Android 负责发起签约和查询，服务端负责收费与算力账本。

## 业务规则

- 首次签约立即申请首扣。续费计划为到期日前第 3 个北京时间自然日 02:00。
- 模板必须为微信 V2「通知后 24 小时自动扣费」。首次/重新签约后 12 小时内申请可立即执行，之后通常延时 24 小时；提前三天提高成功率，不保证一定续费成功。
- 同一用户、固定周期只保存一个 `wechat_txn`。协议改变不能产生同一期第二份收费。
- `wechat_attempt` 保存每次实际提交的商户订单、协议和结果。只有上次明确失败，才允许下一次尝试；同一周期默认最多 3 次，每次重试不得早于上次尝试后的下一个北京时间自然日 02:00。
- 超时、已受理、结果未知先查询原订单，不换订单号盲目扣款。确认 ORDERNOTEXIST 后，生效协议可有限重发同一订单号，处理登记完成但未发请求就中断的情况。
- 实际支付成功即发 200 算力，可提前使用。旧额度保持原到期日，新额度在下一周期结束时过期。消费优先使用先到期的额度。
- 支付确实晚于计划周期起点时，以微信返回的实际付款时间起算一个月；迟到回调使用付款时间，不以回调到达时间延长周期。
- 取消自动续费不退款、不收回已付算力。已提交订单即使解约后成功，仍入账，但不恢复旧协议。
- 重新签约前先查询旧的未决订单。仍未知返回 HTTP 409 `payment-pending`；旧单已付款则衔接已付到期日。不能用解约成功证明旧单未扣款。
- 三次失败后停止该周期自动尝试，协议仍可取消，已付权益自然到期。用户需要恢复时可取消旧协议后重新签约；新的明确授权可开启新的重试预算。未知订单未核实前不能通过重签绕过。

## 商户配置

必须配置 `USAGE` D1 绑定及以下 Secret/变量；不要把真实值提交到 Git：

- `WECHAT_PAY_MCH_ID`：商户号，与 AppID 已绑定。
- `WECHAT_PAY_APP_ID`：Android 应用使用的 AppID。
- `WECHAT_PAY_PLAN_ID`：获批月度委托代扣模板。
- `WECHAT_PAY_API_V2_KEY`：XML V2 签名密钥。
- `WECHAT_PAY_CALLBACK_BASE_URL`：显式公网 HTTPS origin，例如 `https://voicedrop.cn`。
- `WECHAT_PAY_CHARGE_MODE=notify_after_24h`。
- 可选 `WECHAT_PAY_AMOUNT_FEN`，默认 1990。已创建周期金额固定；不能通过环境变更追溯修改订单。改变产品售价仍须同步获批模板、客户端告知和产品规则。
- 可选 `WECHAT_PAY_QUERY_MODE=pap`：仅已获专用查单权限时启用。默认通用 `/pay/orderquery`；专用 `/pay/paporderquery` 官方文档标注灰度限制，不自动猜测权限或切换接口。

注册回调地址：

- `/agent/wechat-pay/contract-notify`：签约 ADD。
- `/agent/wechat-pay/cancel-notify`：解约 DELETE。
- `/agent/wechat-pay/pay-notify`：支付结果。

预签约仍调用 `/papay/preentrustweb`，扣款固定 `/pay/pappayapply`。新模板由 `WXLaunchMiniProgram` 调起，旧模板按微信权限使用 `WXOpenBusinessWebview` businessType 12。必须用实际商户配置在真机验证 SDK、模板权限和回调可达性。

## 首次上线建表

微信支付功能尚未上线，最终表结构直接定义在 `0005_wechat.sql`，不提供旧微信订单迁移或历史数据修复脚本。首次启用前按项目现有 D1 建表流程执行至 0005，再启用对应 Worker。

建表包含用户周期唯一约束、同时生效协议约束、入账唯一约束及扣款尝试表。它们是防止并发重复扣款和发放的组成部分。

## 调度与恢复

`wrangler.jsonc` 配置 `0 18 * * *`，每天北京时间 02:00 运行一次：先查未决订单，再处理到期扣款与重试。首次签约仍即时申请扣款，成功回调即时入账；漏掉回调的订单由次日任务查单补账。任务按主键分页，重复执行由数据库条件更新和唯一约束防重。

- `wechat_txn`：用户周期及其已付权益；`paid` 不能被迟到失败通知覆盖。
- `wechat_attempt`：不可复用到其他协议的商户订单。`sending/unknown/accepted` 保留待查询，明确失败才允许下一笔尝试。
- `wechat_sub`：支付授权的状态。`active → cancelled` 合法，不改变支付订单是否已付。
- 原子 D1 batch 同时写 bucket、ledger、account、订单和权益。中途失败全部回滚，成功回调或查单可重试。
- 回调校验签名、商户、应用、订单金额及协议。回调存储不可用返回失败，不能确认一个未处理的付款。
- 查询异常、退款、超出查询能力的长期未知订单必须审计并人工对账。退款算力撤销政策不在本次自动实现范围；发现退款不会因此再扣一次费。
- 只有确认无此订单且原协议仍生效时才能同号重发，最多三次。若协议已取消或状态持续未知，保留原单并人工查商户账单，不能自动释放为新订单。

## 客户端契约

现有 contract/cancel/status 路径保持不变。`/wechat-pay/status` 的 `active` 只表示已付权益；`can_cancel` 表示可解除的授权；`scheduled_charge_at` 仅在新协议未付款时返回。

新增兼容字段 `payment_pending`、`renewal_stopped` 供后续客户端明确提示。`/subscription/status` 仍供两端购买前检查 Apple/微信状态；iOS 需要同步消费此共享接口，当前后端只能阻止已有 Apple 再开微信。

Android 从微信返回后应有限轮询状态，同时刷新余额和流水。收到 `payment-pending` 时应提示旧支付正在确认，不要自动循环发起签约。

## 售卖开关

私有 R2 `config/wechat-pay.json` 显式写 `{"enabled":false}` 才关闭新售卖。删除文件会按现有策略重新初始化为 `true`，不能用删除关闭入口。开关不影响已有协议的续费、解约、回调和对账；R2 异常仍沿用现有默认开启策略。

## 验证

```sh
npm test -- --no-cache
```

重点回归 `test/wechat-lifecycle.test.js`：重复/并发通知、原子回滚、取消后付款、付款后取消再重签、旧单未决、同号恢复、三次失败、提前发放、分页和并发扣款时间校验。

真机与商户联调需覆盖：首扣、普通续费的 24 小时通知行为、余额不足、解约重签、成功回调延迟、查单权限和老模板兼容。测试模拟器通过不等同于真实商户验收完成。

官方依据：[申请扣款](https://pay.wechatpay.cn/doc/v2/merchant/4011987377)、[通用查单](https://pay.wechatpay.cn/doc/v2/merchant/4011987538)、[专用查单](https://pay.wechatpay.cn/doc/v2/merchant/4013894074)、[签约/解约通知](https://pay.wechatpay.cn/doc/v2/merchant/4011987586)。
