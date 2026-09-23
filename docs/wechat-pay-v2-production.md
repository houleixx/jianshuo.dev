# 微信支付 V2 上线配置清单

适用于当前 Android 微信按月订阅实现：首次付款并签约、付款后补签约、有效期内恢复签约、解约和周期代扣。

本清单记录代码要求和已验证的测试配置，不表示生产环境已配置或部署完成。密钥不写入本文档，也不提交到 Git。

## 配置位置

支付参数配置在生产 Cloudflare Worker **`voicedrop-agent`**，不是测试 Worker `voicedrop-agent-test`，也不是 Pages 项目。

控制台入口：对应 Worker → Settings → Runtime variables and secrets → Production（生产）。测试 Worker 中的同名 Production 标签仍然属于测试 Worker 自身的部署。

## 必需参数与收费金额

| 配置名 | 配置类型 | 配置值 | 说明 |
|---|---|---|---|
| `WECHAT_PAY_MCH_ID` | 普通变量 | `1714204101` | 当前已验证的商户号；生产沿用同一商户时可使用。 |
| `WECHAT_PAY_APP_ID` | 普通变量 | `wx1573f936967f5420` | 当前 Android 应用使用的微信 AppID，需与商户配置匹配。 |
| `WECHAT_PAY_PLAN_ID` | 普通变量 | `223558` | 当前已验证的委托代扣模板 ID；生产使用前确认沿用该模板及其收费规则。 |
| `WECHAT_PAY_API_V2_KEY` | **Secret** |  | 对应商户的 API V2 密钥，由有权限的人员直接录入 Cloudflare。此处留空，不代表运行时可以为空。 |
| `WECHAT_PAY_CALLBACK_BASE_URL` | 普通变量，也可用 Secret | `https://jianshuo.dev` | 按仓库当前生产路由填写的回调 origin，只填协议和域名，不加 `/agent` 或具体回调路径。 |
| `WECHAT_PAY_AMOUNT_FEN` | 普通变量 | 上线前确认正式金额 | 每期金额，单位为分，必须为正整数。代码默认 `1990`（19.90 元）；测试值 `1` 为 0.01 元，不应未经确认直接沿用到正式售卖。建议显式配置。 |

前五项为必需参数；`WECHAT_PAY_AMOUNT_FEN` 可省略但会使用代码默认值。商户号、AppID、模板 ID 属于标识，不是支付密钥。

回调路径由代码自动拼接，例如：

- `https://jianshuo.dev/agent/wechat-pay/app-pay-notify`：首期支付通知。
- `https://jianshuo.dev/agent/wechat-pay/contract-notify`：签约状态通知。
- `https://jianshuo.dev/agent/wechat-pay/pay-notify`：续费代扣通知。

生产回调必须实际到达生产 Worker，不能指向测试域名。

## 可选参数

| 配置名 | 配置类型 | 默认值 | 说明 |
|---|---|---|---|
| `WECHAT_PAY_CONTRACT_DISPLAY_ACCOUNT` | 普通变量 | `VoiceDrop 包月算力` | 首次支付并签约请求中的展示名称，可不配置。目前纯签约、补签约请求仍使用代码内固定的同名文案。 |

## 保留的共享配置与资源

以下是后端已有的共享配置，不属于 V3 专用配置，应继续保留：

| 名称 | 类型 | 说明 |
|---|---|---|
| `SESSION_SECRET` | Secret | 会话验证，沿用生产环境现有配置；值不写入文档。 |
| `FILES_TOKEN` | Secret | 后端已有文件与管理功能使用，沿用现有配置；值不写入文档。 |
| `USAGE` | D1 绑定 | 生产 `voicedrop-usage` 数据库，保存协议、订单、扣款尝试、权益及账本。 |
| `FILES` | R2 绑定 | 生产 `jianshuo-dev-files` 存储桶，也保存支付售卖开关。 |

这不是 Worker 的全部依赖清单；其他现有服务配置和资源绑定继续保留。

售卖开关位于 R2 的 `config/wechat-pay.json`，内容为 `{"enabled": true}` 或 `{"enabled": false}`，不属于环境变量。当前代码在文件缺失时会尝试初始化为开启；读取或解析异常时也默认开启，因此不能依赖“未创建该文件”来暂停售卖。

## V3 配置清理

当前 V2 实现不再读取以下五项：

- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_MCH_PRIVATE_KEY`
- `WECHAT_PAY_MCH_SERIAL_NO`
- `WECHAT_PAY_PUBLIC_KEY`
- `WECHAT_PAY_PUBLIC_KEY_ID`

上述五项已从测试 Worker 清理。生产环境应在确认运行版本已切换至 V2 后清理；本文档不表示生产环境已执行删除。

保留 `WECHAT_PAY_API_V2_KEY`，其用途包括支付、签约、查单、查约、解约和 XML 通知验签。

## 部署时的配置检查

1. **变量保留**：当前生产 `agent/wrangler.jsonc` 没有设置 `keep_vars`，支付普通变量也未列入其 `vars`。部署前需确定变量管理方式：将非敏感参数合并进受版本控制的 `vars`，或明确启用保留控制台变量的部署方式。保留现有其他变量；密钥仍使用 Secret。部署后再次核对参数。
2. **数据库**：核对生产库是否已有微信支付表。`agent/migrations/0005_wechat.sql` 是当前最终结构的初始化脚本，不是旧版支付表的升级脚本。已有旧版表时，先按实际结构制定迁移，不能直接重复执行。
3. **后端发布**：当前主分支 GitHub 工作流自动部署 Pages；支付所在的 Agent Worker 需单独部署。仅合并主分支不等于支付后端上线。
4. **定时任务**：生产配置包含 `0 18 * * *`（北京时间每日 02:00）。当前 `*/5 * * * *` 分支也执行支付调度与补偿查询；部署后核对实际 Cron 配置。
5. **Android 发布**：Debug 包连接测试环境；Release 包使用生产线路。需构建并发布正式包，单纯合并主分支不会自动发布 APK。
6. **生产验证**：确认正式金额、回调路由、首次付款与签约、权益发放、解约后的扣款停止，以及自动续费任务的运行状态。

## 代码依据

- 参数检查、金额默认值、签约与回调：[agent/src/wechat-pay.js](../agent/src/wechat-pay.js)
- V2 签名与请求：[agent/src/wechat-v2.js](../agent/src/wechat-v2.js)
- 生产 Worker、数据库、存储及 Cron：[agent/wrangler.jsonc](../agent/wrangler.jsonc)
- 定时任务入口：[agent/src/index.js](../agent/src/index.js)
- 支付数据库初始化：[agent/migrations/0005_wechat.sql](../agent/migrations/0005_wechat.sql)
- Pages 部署工作流：[.github/workflows/deploy-pages.yml](../.github/workflows/deploy-pages.yml)
