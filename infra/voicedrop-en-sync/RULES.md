# VoiceDrop 中文页 → 英文镜像 翻译规则（单一真源）

本文件是 /voicedrop/（中文）→ /voicedrop/en/（英文镜像）的翻译规范。
首次人工翻译和之后的夜间自动同步都必须遵守本文件。改口径改这里。

## 范围

翻译这些中文源页面到 en/ 镜像（相对路径一一对应）：

| 中文源 | 英文镜像 |
|--------|---------|
| voicedrop/index.html | voicedrop/en/index.html |
| voicedrop/welcome/index.html | voicedrop/en/welcome/index.html |
| voicedrop/help/index.html | voicedrop/en/help/index.html |
| voicedrop/community/index.html | voicedrop/en/community/index.html |
| voicedrop/articles/index.html | voicedrop/en/articles/index.html |
| voicedrop/agent/index.html | voicedrop/en/agent/index.html |
| voicedrop/privacy/index.html | voicedrop/en/privacy/index.html |
| voicedrop/developer/index.html | voicedrop/en/developer/index.html |
| voicedrop/developer/api.html | voicedrop/en/developer/api.html |
| voicedrop/developer/api.md | voicedrop/en/developer/api.md |
| voicedrop/developer/wjs-voicedrop.html | voicedrop/en/developer/wjs-voicedrop.html |

**不翻**：voicedrop/admin/**（内部后台）、voicedrop/shared.js（纯代码）、voicedrop/api.html。

## 硬规则

1. **结构零改动**：HTML 结构、内联样式、class/id、JS 逻辑、动画全部保持不变。只翻文字。不要重排版、不要"顺手优化"。
2. **要翻的东西**：可见文本节点、`<title>`、meta description、og:title/og:description、alt、aria-label、placeholder、JS 里渲染到界面的字符串字面量（如演示数据的地名）。
3. **不翻的东西**：JSON 的 key、API 参数名、URL、代码标识符、命令行示例中的命令本身、`jianshuo@hotmail.com`。代码示例里的中文示例值（如文章标题示例）可以翻成英文让老外看懂。
4. **链接改写**：站内 voicedrop 链接指向 en 树——`/voicedrop/` → `/voicedrop/en/`、`/voicedrop/help/` → `/voicedrop/en/help/`，以此类推。以下保持原样：外链、TestFlight/APK 下载、`/voicedrop/shared.js` 等资源引用、所有 API/fetch 端点、admin 链接。
5. **head 处理**：`lang="en"`；og:url 加上 en/ 路径；并加双向 hreflang：
   ```html
   <link rel="alternate" hreflang="zh-CN" href="https://jianshuo.dev/voicedrop/<相对路径>">
   <link rel="alternate" hreflang="en" href="https://jianshuo.dev/voicedrop/en/<相对路径>">
   <link rel="alternate" hreflang="x-default" href="https://jianshuo.dev/voicedrop/<相对路径>">
   ```
6. **语言切换器**：英文页里加一个「中文」链接指回中文对应页——页面如果有 header nav 就放 nav 里（下载按钮之前），没有就放 footer 链接组里。样式抄旁边链接的内联样式。（中文页加「EN」由主流程统一做，不在本规则内。）
7. **页脚**：ICP 备案行原样保留；`© 2026 王建硕` → `© 2026 Jian Shuo Wang`。
8. **文案质量**：自然的英文产品文案，不要直译腔。页面里已有的英文 tagline（如 "Speak it, it files itself."）原样保留并可作为语感基准。中文页有些地方是"中文大标题+英文小注"的双语排版，英文版把英文提升为主标题，删掉重复的小注或换成一句补充语。

## 术语表

| 中文 | English |
|------|---------|
| 口述备忘 | voice memo（产品定位语境用 voice-first memo） |
| 开口说，它自己归档 | Speak it, it files itself. |
| 文件中转站 / 中转站 | file relay / your own relay |
| 归档 | archive |
| 挖矿 / 挖文章 | mining / mine articles |
| 文风 | writing style |
| 追问 | follow-up questions |
| 算力 | credits |
| 测试群 / 测试用户群 | beta group |
| 帮助中心 | Help Center |
| 开发者 | Developers |
| 隐私政策 | Privacy Policy |
| 社区 | Community |
| 公众号 | WeChat Official Account |
| 微信 | WeChat |
| 视频号 | WeChat Channels |
| 小红书 | Xiaohongshu (RED) |
| 王建硕 | Jian Shuo Wang |
| 上海 · 浦东新区（演示地名） | Shanghai · Pudong（城市保留拼音，区名用通行英文） |
| 喂币 / 投币 | Feed a coin（玩法名 Feed-a-Coin mining） |
| 开口说，它自己成文 | Speak it, it writes itself. |
| 偷师 | Style Learning |

## 既定裁量（夜间同步沿用，不要改回）

- API 文档里服务端实际返回的中文协议字符串（如 `"message":"正在修改，请稍候"`）保留中文原文，后面加英文注释——那是协议契约不是文案。
- articles 页的「中文/EN」切换链接要用 onclick 把 `location.search`（JWT token）带过去，否则切语言丢 token。
- welcome 页英文版复用中文页同一张群二维码（绝对路径 `/voicedrop/welcome/group-qr.jpg`）。

## 夜间同步约定

- **执行者：claude.ai 云端 routine `voicedrop-en-sync`**（trig_01CYcbWBm8DJLvefmEsHiKXD，
  每天 UTC 18:30 = 东京凌晨 3:30），管理入口 https://claude.ai/code/routines 。
- manifest：`infra/voicedrop-en-sync/manifest.json`，记录每个中文源文件上次翻译时的 sha256。
- 同步时：对比当前 sha256 与 manifest，只重翻变更了的文件（整页重翻，覆盖 en 镜像），翻完更新 manifest。
- 新增的中文页（在范围表里的目录下）自动纳入；删除的中文页，en 镜像同步删除。
- 完成后 commit + push main。**部署由 GitHub Action `.github/workflows/deploy-pages.yml`
  自动完成**（push 到 main 且涉及 voicedrop/** 时触发，需要仓库 secrets
  CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）。routine 自己不部署。
- 本目录的 `sync.sh` 保留作本地手动工具（SEED_ONLY=1 重种 manifest / DRY_RUN=1 看变更清单 /
  直接跑=本地全流程），日常不再依赖它。
