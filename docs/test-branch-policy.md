# 测试分支与生产分支约定

## 目的

测试环境必须与生产环境的 Cloudflare 资源、密钥和部署方式隔离。测试专用配置不得进入 `main`，避免测试 Worker、D1、R2 或 GitHub Secret 的引用被误用于正式环境。

## 分支职责

| 分支类型 | 用途 | 可包含的内容 |
| --- | --- | --- |
| `main` | 正式发布的唯一来源 | 正常业务代码、通用测试、生产部署配置和生产文档 |
| 功能分支（例如 `feat/*`） | 开发与代码审查 | 正常业务代码、数据库迁移、通用测试；完成后合并至 `main` |
| `test` | 独立测试环境的集成与自动发布 | `main` 的待测代码快照，加上仅限测试环境的配置 |

这里的“通用测试”包括 `agent/test/**`、`reco/test/**` 等自动化测试代码；它们是产品代码的一部分，应该随功能分支进入 `main`，不是“测试环境配置”。

## 固定流程

1. 新功能先在功能分支开发、测试，并通过 PR 合并到 `main`。
2. 将已在 `main` 的代码合并或挑选（cherry-pick）到 `test`，触发测试环境部署。
3. 仅测试环境需要的调整只提交到 `test`，绝不从 `test` 向 `main` 创建 PR，也不将 `test` 合并回 `main`。
4. 如果测试发现业务问题，修复应回到新的功能分支，再按第 1、2 步流转；不要直接把业务修复只留在 `test`。

## 禁止进入 `main` 的文件

下列文件或目录是测试环境专用内容，禁止合并到 `main`：

- `wrangler.test.jsonc`
- `agent/wrangler.test.jsonc`
- `reco/wrangler.test.jsonc`
- `.github/workflows/deploy-test.yml`
- `agent/docs/wechat-pay-test-environment.md`

新增测试账号资源时，也只能新增相应的 `*.test.*` 配置或测试环境文档到 `test`；其中不得写入真实密钥。密钥始终只放 GitHub Secrets 或 Cloudflare Secrets，测试使用 `CLOUDFLARE_TEST_*`，生产使用独立的生产密钥。

## 强制措施

`.github/workflows/block-test-config-from-main.yml` 会在任何目标为 `main` 的 PR 上检查上述路径，一旦检测到即失败。

要让它成为不可绕过的规则，需要将这个**不含测试资源配置**的防护工作流单独合并到 `main`，然后在 GitHub 仓库的 **Settings → Rules → Rulesets（或 Branch protection）→ main** 中把 `block-test-config-from-main / reject-test-only-config` 设置为 Required status check，并限制直接推送 `main`。
