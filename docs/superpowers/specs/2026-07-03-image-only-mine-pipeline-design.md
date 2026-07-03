# 图片生文（image-only 挖矿）多遍流水线设计

日期：2026-07-03
状态：方向已确认（方案 A「编辑部流水线」+ JPG/地点元数据），本 spec 待建硕过目
范围：`jianshuo.dev/agent`（VoiceDrop 挖矿 Worker）。**不改 iOS App。**

## 1. 背景与问题

VoiceDrop 录音无语音但带照片时，走「看图写文」路径：`IMAGE_ONLY_SYSTEM`（`agent/src/prompts/mine.js`）一次 LLM 调用，硬性要求标题 ≤14 字、正文 2–4 句。当初为防编造刻意压薄——没有口述，事实底料几乎为零，硬写长文只能注水。

结果是图文记录只是「配文」，不是文章。高水平文章 = 事实底料 × 立意 × 文风执行；纯图片路径缺前两样。本设计用多遍流水线 + 真实元数据 + 个人语料把前两样挣回来，不靠逼模型编。

参考：外部文档《图片自动成文 Agent 技术设计文档》验证了「自动化写作编辑部」方向。借鉴其五点：结构化阶段契约（JSON + confidence + reason）、质量评分门 + 定向回退、Vision 结果缓存、image_role_map、分阶段温度。有意不同三点：立意锚在个人语料 + 真实元数据（非平台模板/受众推断，文风系统已覆盖）；事实底料含服务端免费元数据；规模缩到 4 次调用（对方 Beta 期 10 Agent，其 MVP 1 与本设计重合）。

## 2. 目标 / 非目标

**目标：**
- image-only 记录产出「有观察、有立意、经过自审」的短文，长度顺内容走，不设下限
- 硬底线不放松：绝不编造；低置信度观察只能以推测口吻出现
- 质量下限 ≥ 现行单发：任一阶段失败立即回退现行路径
- 先用现有 eval harness A/B 验证胜出，再打开开关

**非目标（二期另立 spec）：**
- Web 检索增强（方案 B）
- 「问回来」App 交互（方案 C）
- App 侧精确 GPS/EXIF（照片被 `UIImage.jpegData` 重编码剥掉 EXIF；一期只用文件名地点标签）
- 有语音的正常挖矿路径——完全不动

## 3. 现状（代码事实）

- 入口：`miner.js` runMine 无 transcript 分支（约 line 1046）：`gatherPhotos` → `mineVariant({systemOverride: IMAGE_ONLY_SYSTEM, noForce: true, photoInstr: ""})`
- 照片：`photos/<sessionTs>/*.jpg`；`loadPhoto` 产出 `{b64, label(拍摄时刻 HH:MM:SS), relKey}`
- 地点：iOS `LocationTagger` 已把反地理编码的「City-District」ASCII 标签写进录音文件名；Worker 端目前**未解析、未使用**
- 文风：`CLAUDE.json`（schema-3）版本化文风，`resolveStyle`
- 历史文章：`${scope}articles/<stem>.json`，`doc.articles[].title`
- 记账/日志：`mineVariant` 内每次调用 `writeLlmLog` + `debit`
- eval：`agent/eval/run-eval.mjs`，`fixtures/local` 金标优先，champion vs candidate，proxy-checks + 盲评 judge（`/wjs-evaling-voicedrop-prompts`）

## 4. 总体设计：五个阶段

只有 Stage 1、4 传照片 base64；Stage 2、3 用观察 JSON 替代图片（成本红利：现行单发把全部照片一次全喂，流水线图 token 仅 ×2）。

### Stage 0 素材整备（纯代码，零 LLM 成本）

- 从 audio leaf 解析地点标签：`VoiceDrop-<date>-<time>-<City-District>.m4a` → `"Shanghai-Xuhui"`（无标签 → null）
- 照片拍摄时刻（现有 label）
- 最近 N=20 篇历史文章标题：R2 list `${scope}articles/` 取尾部 20 个 key（key 含时间戳，字典序即时间序），并行 GET 摘 title；任一失败静默降级为空列表
- 产出 **FactPack**：`{place, sessionDate, photos:[{key, time}], recentTitles[]}`

### Stage 1 观察（带图，temperature 0.2）

- 输入：照片 + FactPack
- 输出 **Observation** JSON：每图 `{key, caption, ocr_text[], objects[], scene, people, light_season, importance(0–1), role_guess, confidence(0–1)}`；多图补 `{timeline, clusters, repeated_entities}`
- 规则：OCR 只抄真看得见的字（招牌/菜单/书页）；拿不准就压低 confidence，不硬猜
- Observation 存进 article doc 的 `vision` 字段——restyle 复用，不再重新看图

### Stage 2 立意（不带图，temperature 0.3）

- 输入：Observation + FactPack（含历史标题）
- 输出 **StoryPlan** JSON：`{candidates:[{theme, evidence_keys, score, reason}], selected, rejected_because, thesis, title_options, sections:[{purpose, image_keys, key_points}], image_role_map}`
- 候选 ≥3 个，评分维度：观察支撑度 / 信息价值 / 「具体→抽象架梯子」味
- 历史标题用途：避免重复选题 + 话题延续（仅当标题明确支持时才可写「之前写过…」）

### Stage 3 写作（不带图，temperature 0.7）

- 输入：StoryPlan + Observation + FactPack + 文风文本（现有 `resolveStyle`）
- 输出与现行一致的 `{articles:[{title, body}]}`；一期固定以 1 篇为主（image-only 场景天然单主题，沿用「少而厚」）
- 硬底线：断言只能来自 confidence ≥ 0.7 的观察 + FactPack 元数据；低置信度必须带推测口吻（「像是」「可能」）；不提公司具体名字；盘古之白；`[[photo:key]]` 独占一行、每图一次，规则沿用

### Stage 4 审稿定稿（带图，temperature 0.1）

- 输入：草稿 + 原照片 + Observation + StoryPlan
- 任务：逐句核事实忠实度（对照原图抓误读）、照片遗漏/标记错误、跑题、空话堆砌
- 输出：`{articles:[修订终稿], quality:{faithfulness, on_theme, structure, overall 0–100}, issues[]}`
- 门槛：`overall ≥ 70` → 交付修订稿；`< 70` → 带 issues 回到 Stage 2 重跑（**最多 1 次**）；二跑仍不达标 → 交付分数较高一版，minelog 标 `low_quality`

### 失败回退梯（质量下限 = 今天）

任何阶段 JSON 解析失败 / LLM 错误 / 超时 → 立即放弃流水线，走现行 `IMAGE_ONLY_SYSTEM` 单发；回退原因记 minelog。现行代码路径保留不删。

## 5. 工程落位

- **prompts**：新文件 `agent/src/prompts/image-pipeline.js`，导出 `OBSERVE_SYSTEM / PLAN_SYSTEM / WRITE_SYSTEM / REVIEW_SYSTEM`，单一真源（生产与 eval 同 import），文件头注释沿用 `mine.js` 惯例
- **orchestrator**：新模块 `agent/src/image-mine.js`，`export async function mineImageOnly(env, ctx)`；`miner.js` 无语音分支改为：开关开 → 调 `mineImageOnly`，其内部失败自动回落现行 `mineVariant` 调用
- **LLM 调用**：`image-mine.js` 内建 `callStage(payload)`（Anthropic / openai-compat 两分支，同 `generateArticles` 的分发逻辑）；每阶段 `writeLlmLog(source:"mine", meta.stage:"observe|plan|write|review")` + `debit(meta.stage)`
- **数据模型**：article doc 增量字段 `vision`（Observation）与 `plan`（StoryPlan 精简版）；schema 仍为 2（App 忽略未知字段，无客户端影响）
- **restyle 复用**：`restyleArticle` 检测 `doc.vision` 存在 → 只重跑 Stage 3+4（换文风重写 + 审稿），不重跑观察/立意、不重传照片——更快更省
- **开关**：`modelCfg.imagePipeline`（布尔，缺省 `false`）；eval 胜出后打开

## 6. eval 计划

- fixtures：新增 image-only 金标 `fixtures/local/image-*.json`（照片 b64 + 期望要点），从真实 R2 历史 image-only session 抽 5–8 组
- `run-eval.mjs` 扩展：支持 pipeline candidate（champion = 现行单发；candidate = 四阶段串行）
- proxy checks 增补：photo 标记完整性、正文长度分布、OCR 引用率、编造检测（正文实体 ⊆ Observation + FactPack）
- judge 盲评维度沿用：信息密度 / 无编造 / 立意 / 文风
- **通过标准**：candidate 胜率 ≥ 60% 且编造项零回归 → 打开 `imagePipeline`

## 7. 成本与延迟

- 调用数 1 → 4，但仅 Stage 1、4 带图：估算单次成本 ≈ 现行 2–2.5×；image-only 记录占比小，绝对增量可控
- 延迟：串行 4 调用约 30–60s；挖矿本就是异步后台（`notifyStatus` mining→ready），可接受
- Worker 子请求：20 GET（历史标题）+ 4 LLM + 现有读写，远低于 paid plan 上限 1000

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 图片误读写成断言 | confidence 分级 + Stage 4 带原图核查 + faithfulness 门 |
| 逐图流水账 | thesis + 章节 purpose + image_role_map 强制 |
| 多阶段 JSON 脆弱 | 每阶段 parse 失败即整体回退现行单发；prompt 给严格 schema + 示例 |
| 成本失控 | 仅 2 阶段带图；重试上限 1；开关默认关 |
| 历史标题拉取拖慢 | 并行 GET + 上限 20 + 失败降级空列表 |
| 与有语音路径漂移 | 有语音路径零改动；共享 `loadPhoto`/`gatherPhotos`/debit/llmlog 基建 |

## 9. 二期路线（另立 spec）

- **B 检索增强**：观察出可查证实体（书名/店名/地标）→ web search → 有据事实层
- **C 问回来**：看图生成 2–3 个具体问题推送用户，30 秒语音回答后走正常「转写+照片」挖矿
- **App 侧精确位置**：photo sidecar JSON 携带 placemark（venue 名），补充文件名粗标签
- 观察缓存扩展到有语音路径的照片（restyle 全面提速）

## 10. 开放问题

- 历史标题 N=20 是否合适（做成可配）
- 质量门阈值 70 为初拍值，eval 金标校准后调整
- Stage 2 一期不做多篇拆分；若真实数据出现明显多主题 session 再放开
