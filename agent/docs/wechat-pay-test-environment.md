# 微信包月测试环境

此环境部署到**另一个 Cloudflare 账号**，所有可写资源必须独立；严禁复用正式 D1 或 R2。它不是微信支付沙箱：微信委托代扣没有沙箱，仍会使用真实测试模板和小额真实扣费。

## 1. 在目标 Cloudflare 账号创建资源

在该账号已登录的终端中执行：

```sh
cd ~/code/jianshuo.dev/agent
npx wrangler d1 create voicedrop-usage-test
npx wrangler d1 create voicedrop-reco-test
npx wrangler d1 create voicedrop-core-test
npx wrangler r2 bucket create voicedrop-test-files
```

把三条 D1 创建命令输出的 `database_id` 填入仓库中的 `wrangler.test.jsonc`。若要在首次部署时绑定自定义域名，再增加并替换：

- `REPLACE_WITH_TEST_DOMAIN`：例如 `agent-test.example.com`
- `REPLACE_WITH_TEST_ZONE`：例如 `example.com`

没有测试域名时，可以先不配置 `routes`，Worker 会发布到 `workers.dev` 地址，并把该地址写入 `WECHAT_PAY_PUBLIC_ORIGIN`；只要微信商户后台接受该 HTTPS 回调域名，即可用于测试。若商户后台要求备案/白名单自定义域名，再补自定义 Route。

`wrangler.test.jsonc` 不含私密值；填写完成后应提交到测试分支。Cloudflare 的 Git 构建只读取仓库中的文件，不能读取你电脑上未提交的配置。该文件使用 `voicedrop-agent-test`，因此不会覆盖正式 `voicedrop-agent`。

## 2. 迁移与首次部署

```sh
npx wrangler d1 migrations apply voicedrop-usage-test --remote --config wrangler.test.jsonc
npx wrangler d1 migrations apply voicedrop-core-test --remote --config wrangler.test.jsonc
npx wrangler deploy --config wrangler.test.jsonc
```

部署后，在目标账号的 Worker 中绑定测试域名 `https://<测试域名>/agent/*`；不要开 Cloudflare Access，否则微信服务器无法回调。

使用 Cloudflare Git 部署前，先将填写完成的 `wrangler.test.jsonc` 提交到该测试分支；D1 的 `database_id` 不是密钥，可以随配置提交。所有 API 密钥仍只通过 Worker Secrets 配置，绝不写进 Git。

Cloudflare Git 部署页填写：

| 字段 | 值 |
|---|---|
| 项目名称 | `voicedrop-agent-test` |
| 构建命令 | `cd agent && npm ci` |
| 部署命令 | `cd agent && npx wrangler deploy --config wrangler.test.jsonc` |

## 3. 必须设置的测试 Worker Secrets

先只配置微信测试所需值：

```sh
npx wrangler secret put WECHAT_PAY_MCH_ID --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_APP_ID --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_PLAN_ID --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_API_V2_KEY --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_APPLY_URL --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_PUBLIC_ORIGIN --config wrangler.test.jsonc
npx wrangler secret put WECHAT_PAY_AMOUNT_FEN --config wrangler.test.jsonc
```

其中：

- `WECHAT_PAY_PUBLIC_ORIGIN` = `https://<测试域名>`。
- `WECHAT_PAY_AMOUNT_FEN` 使用获批测试模板允许的金额；通常测试模板为 `10`（¥0.1）。
- 回调地址在微信商户后台配置为：
  - `https://<测试域名>/agent/wechat-pay/contract-notify`
  - `https://<测试域名>/agent/wechat-pay/pay-notify`
  - `https://<测试域名>/agent/wechat-pay/cancel-notify`

若还要测试其它既有后端功能，再按正式环境分别配置 `SESSION_SECRET`、AI/ASR、R2 S3 等 Secrets；不要复制正式生产密钥到测试账号，除非该项确实需要访问同一外部服务且你明确接受该风险。

## 4. 验证边界

- 测试 D1/R2、Worker 名称、Durable Objects 与正式环境完全隔离。
- 微信委托代扣没有沙箱；测试模板/真实测试微信号仍会产生真实小额扣款。
- 测试 Worker 只启用每 15 分钟微信 Cron，不运行挖矿或探活 Cron。

## 5. GitHub 自动部署

推送到仓库的 `test` 分支时，`.github/workflows/deploy-test.yml` 会先执行 Agent 与 reco 的测试，再应用三个测试 D1 的增量迁移；仅在全部成功后，才发布：

- Pages 项目 `voicedrop-test`（含 `/files/api/*`）；
- Worker `voicedrop-agent-test`。
- Worker `voicedrop-reco-test`。

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 新增两个 Repository secrets：

- `CLOUDFLARE_TEST_API_TOKEN`：测试 Cloudflare 账号的 API Token；
- `CLOUDFLARE_TEST_ACCOUNT_ID`：测试 Cloudflare 账号 ID。

该 Token 仅授权测试账号的 Workers、Pages、D1、R2 与 Worker Routes 写入权限。不要复用正式 `CLOUDFLARE_API_TOKEN`，也不要把微信支付密钥写进 GitHub 工作流或配置文件。
