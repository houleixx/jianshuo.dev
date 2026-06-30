# VoiceDrop system prompt 评估系统设计（`wjs-evaling-voicedrop-prompts`）

> 日期：2026-06-30 · 状态：待评审 · 作者：王建硕 + Claude
> 影响范围：新建 skill `~/.claude/skills/wjs-evaling-voicedrop-prompts/` + `jianshuo.dev/agent`（一处小重构 + 新增 `agent/eval/` 数据目录 + prompt 抽成独立文件）

## 1. 背景与目标

VoiceDrop 的「挖矿」靠一条硬编码在 `agent/src/miner.js:95` 的 `SYSTEM` prompt 把口述录音挖成公众号文章。这条 prompt 的好坏直接决定产出质量，但今天：

- 它**埋在代码里**，改一句话要改代码、commit、`wrangler deploy`；
- 改完**无从判断改好了还是改坏了**——只能凭感觉看一两次输出。

要解决两件事，正好对应两层：

1. **结构化存储 + 版本可比较**：把 prompt 抽成独立文件，用 git 当版本库，`git diff` 即版本对比。
2. **效果级评估**：建一套 eval harness，对「候选版 vs 当前生产版」做**同输入、成对盲评**，用数据（而非感觉）判断哪版挖得更好。

eval harness 的运行时是**开发机上的 Claude Code**——裁判用 Opus，人工终审走对话，天然适配。

### 为什么不放 Worker / 不另写本地脚本

讨论过三种运行时，选「本地 Claude Code」：

- **Worker 加 `/admin/eval` 端点**：能 100% 复用生产代码、eval 严格等于生产，但只服务 VoiceDrop、要为人工终审做 UI、eval 调用花账上真钱。
- **本地裸 Node 脚本 + mock `env`**：要手搓一堆绑定、易和生产漂移。
- **✅ 本地 Claude Code（本设计）**：裁判（Opus）和人工终审都是原生的，repo 无关，git 即版本库。代价是必须**把协议钉进 skill**（否则裁判标准会飘）+ 一处生产重构保证 prompt 保真。

## 2. 已拍板的关键决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 运行时 | 开发机上的 **Claude Code**；harness = skill，Claude Code = 运行时 |
| D2 | 版本存储 | 把挖矿 `SYSTEM` 抽到 `agent/src/prompts/mine-system.md`，**git 即版本库**，不另建注册表 JSON |
| D3 | eval 数据位置 | 住 **jianshuo.dev repo** `agent/eval/`（与被测 prompt 同仓、同 git 历史），不放进 skill 目录 |
| D4 | 评估方式 | **同输入、成对盲评**（候选 vs 当前生产版）；不写「标准答案」 |
| D5 | 裁判 | dispatch 一个 **subagent**，固定 rubric、A/B 顺序随机、必须给理由；与生成模型不同家族 |
| D6 | 判定规则 | 候选**胜率 ≥ 70%** 且**人工抽查认可** → 才晋级（更新 `mine-system.md` + commit）|
| D7 | v1 范围 | 只做**挖矿 prompt**（`SYSTEM` + `SYSTEM_FORCE`）；审核 / 语音编辑 prompt 留待后续，是不同 eval 模式 |
| D8 | 生产重构 | 抽出纯函数 `buildMinePrompt(...)`，生产与 harness 共用，保证 prompt 字节一致 |
| D9 | 非目标 | **不测**成本 / 缓存命中 / 延迟（本地缓存行为≠生产）；**不做**无人值守 / 定时跑 |

## 3. 双层架构

| 层 | 答哪个目标 | 实现 |
|---|---|---|
| **版本层** | 结构化存储 + 版本可比较（§1.1） | `SYSTEM` 抽成 `agent/src/prompts/mine-system.md`，生产 import；git diff/log/blame 即版本对比与历史 |
| **效果层** | 效果级评估（§1.2） | skill 跑金标集 + 成对盲评，判候选 vs 生产版 |

两层解耦：版本层即使不跑 eval 也独立有用（prompt 终于不再埋在代码里）；效果层依赖版本层提供「两个可比的版本」。

## 4. 生产侧重构：抽出 `buildMinePrompt`

eval 的第一铁律是**复用生产代码路径，不另写一份 prompt**。今天拼 prompt 的逻辑埋在 `generateArticles`（`miner.js:493` 起），且 `SYSTEM` / `SYSTEM_FORCE` 是模块常量，无法注入候选版本。重构两步：

### 4.1 prompt 文本外置（版本层）

- 新建 `agent/src/prompts/mine-system.md`、`agent/src/prompts/mine-system-force.md`，内容 = 现有 `SYSTEM` / `SYSTEM_FORCE` 原文。
- `miner.js` 改为构建时 import 文本（Workers 打包支持文本 import；若不便则维持常量但**同步**自该文件，单一真源）。
- 此后 `git diff agent/src/prompts/mine-system.md` 就是「prompt 版本对比」。

### 4.2 抽出纯函数 `buildMinePrompt`（保真守则）

把 `generateArticles` 里「从 `staticSystem` / `styleTail` / `transcriptText` 到组装 `system` + `messages` payload」这段（含 Anthropic 的 `cache_control` 断点逻辑）抽成**不依赖 `env`** 的纯函数：

```
buildMinePrompt({ systemPrompt, forcePrompt, styleText, transcript, photos, force, cacheMode, provider })
  → { system, messages, max_tokens, output_config? }   // 即 payload 主体（不含 fetch / apiKey / model）
```

- `generateArticles` 改为：`buildMinePrompt(...)` → 注入 `model`/`apiKey` → `fetch` → `parseArticles`。行为零变化（同 caching 断点、同 schema）。
- harness 直接 import `buildMinePrompt`，把**候选 prompt 文本**塞进 `systemPrompt` 参数，其余参数照生产默认（`cacheMode:"system"`、`provider:"anthropic"`）。
- 这样 harness 跑出的 prompt 字节 == 生产，且 caching 行为对**输出质量**无影响（只影响成本，而成本是 D9 非目标）。

健康副产物：拼提示与 env 副作用（`debit` 计费、`writeLlmLog`）解耦。

## 5. 目录结构

```
jianshuo.dev/agent/
├── src/
│   ├── prompts/
│   │   ├── mine-system.md            # 版本层：挖矿 SYSTEM（git 即版本库）
│   │   └── mine-system-force.md      # 兜底 SYSTEM_FORCE
│   ├── prompt.js                     # 新：纯函数 buildMinePrompt（被生产 + harness 共用）
│   └── miner.js                      # 改：generateArticles 调 buildMinePrompt
└── eval/
    ├── fixtures/
    │   ├── 001-multi-topic.json      # 金标录音：{id, transcript, photos?, tags}
    │   ├── 002-short-emotional.json
    │   └── ...                       # ~10–15 条，覆盖 长/短·单/多主题·带图/不带·情绪/技术
    └── runs/
        └── 2026-06-30-<sha>/         # 每轮一个目录
            ├── outputs/<fixtureId>.{champion,candidate}.json   # 两版各自产出
            ├── verdicts/<fixtureId>.json                       # 每条的裁判结论
            ├── report.md                                       # 人读报告（git 可 diff）
            └── report.json                                     # 机读聚合

~/.claude/skills/wjs-evaling-voicedrop-prompts/
├── SKILL.md                          # 协议：触发词、流程、判定规则
├── scripts/
│   ├── run-eval.mjs                  # Runner：fixtures × 两版 → outputs（调 buildMinePrompt + 模型）
│   ├── proxy-checks.mjs              # 确定性代理检查
│   └── aggregate.mjs                 # verdicts → report.md/json + 判定
└── references/
    └── judge-rubric.md               # 裁判 subagent 的固定 rubric（单一真源）
```

> skill 只放**协议与脚本**；金标集与跑批产物住 jianshuo.dev repo（D3），跟 prompt 同仓同历史。

## 6. 跑一轮 eval 的流程

```
输入：候选 prompt（= mine-system.md 的工作区改动，或某个 git ref） vs 当前生产版（HEAD）

对每条金标录音 fixture：
  ① Runner（run-eval.mjs）
     ├─ 生产版 prompt → buildMinePrompt → 调 Opus-4-8（同生产模型）→ 解析 → 文章 A
     └─ 候选版 prompt → buildMinePrompt → 调模型 → 文章 B
  ② 确定性代理检查（proxy-checks.mjs，两版都跑，零模型成本）
     JSON 合法 · 文章数>0 · 正文长度合理 · moderateArticles() 不误伤 · 事实保留抽检
  ③ 成对盲评（dispatch 一个 judge subagent）
     喂 references/judge-rubric.md，A/B 顺序随机，输出 {winner, 各维度理由}
聚合（aggregate.mjs）
  胜率 + 各维度统计 + 代理检查回退项 → report.md / report.json
判定（D6）
  候选胜率 ≥70% 且无代理回退 且人工抽查点「认可」
    → 晋级：把候选写回 mine-system.md + git commit（附 report 链接）
    → 否则：保留报告，不动生产版
```

**成对盲评的红利（D4）**：只比 A、B 谁好，不需要为每条 fixture 手写「标准答案」，金标集只要攒录音即可，建集成本极低。

## 7. 金标集（fixtures）设计

- 来源：王建硕真实录音的转写**快照**（冻结成文件，不每次临时凑——否则不可复现）。
- 规模：v1 约 **10–15 条**。
- 覆盖维度（tags，确保差异能归因到 prompt 而非选样偏差）：
  - 长度：长 / 短
  - 主题数：单主题 / 多主题（考验「切分」）
  - 媒体：带照片 / 不带（考验 `_PHOTO_INSTR` 路径与 `[[photo:…]]` 标记）
  - 语气：情绪宣泄 / 技术干货 / 日常记事
- 格式：`{ id, transcript, photos?: [{relKey,label,b64}], tags: [...] }`，与 `mineVariant` 入参对齐。
- 维护：风格漂移后定期换血，避免 prompt 过拟合到老录音。

## 8. 裁判 rubric 与协议（`references/judge-rubric.md`，单一真源）

每条 fixture 的裁判 = 一次 dispatch 出去的 subagent，吃固定 rubric，**成对**判 A vs B：

- **协议**：A/B 顺序随机（消除位置偏好）；必须逐维度给**理由**；输出结构化 `{winner: "A"|"B"|"tie", dims: {...}, reason}`；裁判模型与生成模型不同家族（D5，缓解自我偏好）。
- **维度**（对齐王建硕写作信条）：
  1. **选题切分** — 是否正确识别了不同主题、切成了恰当篇数；
  2. **标题** — 是否胸有成竹的断言式、非小白提问式钩子；
  3. **文风像王建硕** — 平实、不讲故事、细节用表格/列表；
  4. **忠实不编造** — 严格忠于转写，无凭空捏造的事实（**一票否决项**）；
  5. **完整性** — 关键要点没漏。
- 钉进文件 = 可复现、跨时间可比；否则退化成「每次凭当下心情看」的 vibes。

## 9. 报告格式

- `report.json`（机读）：每条 fixture 的 winner、各维度、代理检查；总胜率、判定结论。
- `report.md`（人读、git 可 diff）：表格化胜负 + 平手/回退高亮 + 候选 vs 生产 prompt 的 `git diff` 摘要 + 判定建议。
- 可选：按用户「HTML 报告统一进 `/a/`」的惯例，渲一份 HTML 摘要推到 `jianshuo.dev/a/`（v1 非必须）。

## 10. skill 交互（`SKILL.md` 行为）

触发词：`评估 prompt`、`eval prompt`、`挖矿 prompt 改好了吗`、`/wjs-evaling-voicedrop-prompts`。

典型一轮对话：

1. 用户改了 `mine-system.md`（或指定两个 git ref），说「评估一下」。
2. skill 跑 `run-eval.mjs` → 两版产出落 `eval/runs/<date>-<sha>/`。
3. 跑 `proxy-checks.mjs` → 有硬回退（JSON 非法 / 误伤审核）直接亮红、暂停。
4. 对每条 fixture dispatch judge subagent → 收 verdicts。
5. `aggregate.mjs` → 报告 + 判定建议，并把**胜率最接近、分歧最大**的 1–2 条输出并排摆给用户人工终审。
6. 用户点「认可」→ skill 把候选写回 `mine-system.md` 并 commit（commit message 附 report 路径与胜率）；否则保留报告、不动生产。

## 11. v1 范围与扩展位

**v1 只做挖矿 prompt**（`SYSTEM` + `SYSTEM_FORCE`）——最影响输出质量、最适配成对质量评优。

预留扩展位、但 v1 **不做**（不同 eval 模式，硬塞会臃肿）：

- **审核 prompt**（`miner.js:602`）：分类任务 → 该用「带标签样本集 + 算准确率/召回」，不是成对质量比。
- **语音编辑 prompt**（`index.js:58/83`）：交互轨迹 → 需喂「指令序列」而非单录音。

目录与 fixtures 格式按「未来能容纳多 prompt target」预留，但代码只实现挖矿一路。

## 12. 边界与非目标（D9）

- **不测成本 / 缓存命中率 / 延迟**：本地跑的 prompt caching 行为与生产不同；这些回归留给（未来的）Worker 侧检查。
- **不做无人值守 / 定时**：只在开发者坐在机器前、主动触发时跑。
- **不替代人工终审**：机器只负责**便宜地筛掉明显更差的版本**；文风的最后一票永远是王建硕。

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 裁判标准漂移 → 跨时间不可比 | rubric 钉进 `judge-rubric.md` 单一真源（§8）|
| harness prompt 与生产漂移 | 共用 `buildMinePrompt` 纯函数（§4.2），prompt 字节一致 |
| LLM 裁判噪声 / 偏好 | 成对盲评 + A/B 随机 + 异家族裁判 + 多条 fixture 平均 |
| 金标集过拟合 | 定期换血（§7）|
| 模型非确定性致同输入两跑结论不同 | 多条 fixture 聚合胜率，不看单条；判定阈值留 70% 缓冲 |

## 14. 验收标准

1. `agent/src/prompts/mine-system.md` 存在，生产 `generateArticles` 经 `buildMinePrompt` 读它；**线上挖矿行为零变化**（重构前后对同一录音产出一致）。
2. `agent/eval/fixtures/` 有 ≥10 条带 tags 的金标录音。
3. 一条命令能跑完整一轮：两版产出 → 代理检查 → 成对盲评 → `report.md`/`report.json`。
4. 报告含每条 fixture 胜负、各维度、总胜率、判定建议。
5. 判定达标且人工认可后，skill 能把候选写回 `mine-system.md` 并 commit。
6. 全流程在开发机 Claude Code 内完成，无需部署 Worker。

## 15. 开放问题

无（D1–D9 已拍板）。实现期若发现 Workers 文本 import 不便，回退到「常量同步自 `mine-system.md`」方案（§4.1），不影响其余设计。
