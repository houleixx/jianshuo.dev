# 默认文风懒种子设计（`ensureStyleSeeded`）

> 日期：2026-07-01 · 状态：待评审 · 作者：王建硕 + Claude
> 影响范围：`functions/lib/style-store.js`（新增 `DEFAULT_STYLE` + `ensureStyleSeeded`）、`agent/src/prompts/mine.js`（默认风格改为 re-export）、`functions/files/api/[[path]].js`（GET /style 接线）、`agent/src/miner.js`（主挖文路径接线）、`agent/test/style-store.test.js`（新增 4 例）

## 1. 背景与目标

VoiceDrop 每个用户的文风存在 `users/<sub>/CLAUDE.json`（schema-3 版本化信封），没文风时存储里就是**空的**。

但默认的「王建硕风格」其实**已经存在、且已经在用**：

- `agent/src/prompts/mine.js` 的常量 `MINE_DEFAULT_STYLE` 就是王建硕语气 DNA（胸有成竹断言、不用「笔者」、AI 称「他」、细节进表格/列表、保留口语词、不加 AI 味连接词）。
- 用户没有自己文风时，挖文环节（`agent/src/miner.js:472`，`buildMinePrompt` 的 `effectiveStyle` 回退）**已经自动用它生成**。所以新用户的文章其实已经是王建硕味儿了。

也就是说，**生成层面不缺默认风格**。真正缺的是——这份默认风格是**隐形的、不属于用户的**：

| 现状 | 后果 |
|------|------|
| 新用户打开「我的文风」→ `GET /style` 返回 404 | 看到一个**空文风框**，看不到也改不了那份基线 |
| 用户的版本历史从空开始 | restyle / undo **没有 v1 可锚定**，迭代无起点 |
| 默认风格写死在代码里 | 用户无法「在王建硕风格基础上微调」成自己的 |

**目标**：把这份代码里的隐形默认，**懒加载物化**成每个用户自己拥有的、可见可改可回退的 `v1`——当用户**第一次用到 style 内容**时，自动把 `DEFAULT_STYLE` 写成他的 `v1`。

## 2. 已拍板的关键决策

| # | 决策 | 取值 |
|---|---|---|
| D1 | 触发时机 | **两者都触发**：抽一个幂等 `ensureStyleSeeded()`，「读当前文风（GET /style）」和「首次挖文（miner）」谁先碰到谁种 `v1` |
| D2 | 物化语义 | 种成 `v1` = **把当前默认风格冻结成该用户的私有副本**（见 §6 已接受的后果）|
| D3 | canonical 文本位置 | 默认风格文本搬到共享模块 `functions/lib/style-store.js` 的 `DEFAULT_STYLE`；`mine.js` 的 `MINE_DEFAULT_STYLE` 改为 re-export，**字节完全一致** |
| D4 | 版本来源标记 | 种下的 `v1` 用 `source: "default"`（与现有 `app`/`agent`/`mine` 并列），便于 UI/分析区分「默认基线」与「用户自撰」|
| D5 | 幂等 & 保护 | 第二次调用不产生 `v2`；遗留 `CLAUDE.md` 有文风的老用户**不会被默认值覆盖** |
| D6 | 不种的入口 | `GET /style/history`、`PUT /style`、`PATCH /style/head` 一律**不种**；只有「读当前文风」和「挖文」算首次用 |
| D7 | 非目标 | **不做**「默认风格升级后自动回灌存量用户」的迁移钩子（YAGNI，§6 留了将来挂点）|

## 3. 架构

`functions/lib/style-store.js` 已是**共享模块**，被 agent worker（`miner.js`、`tools.js`）和 Files API（`functions/files/api/[[path]].js`）双向 import。种子逻辑放这里，两条路天然共用同一份代码、同一份默认文本。

```
functions/lib/style-store.js  ←── 共享单一真源
   ├─ export const DEFAULT_STYLE = `胸有成竹…`   (canonical 文本，从 mine.js 搬来)
   ├─ export async function ensureStyleSeeded(env, styleKey, legacyKey) → doc | null
   └─ export function isDefaultSeed(doc) → bool   (是否仍是未编辑的默认基线)

agent/src/prompts/mine.js
   └─ import { DEFAULT_STYLE } from "…/style-store.js"
      export const MINE_DEFAULT_STYLE = DEFAULT_STYLE   (re-export，下游零改动)

functions/files/api/[[path]].js  (GET /style)   ─┐
agent/src/miner.js  (主挖文路径)                 ─┴─→ 调用 ensureStyleSeeded
```

## 4. 新增/改动详情

### 4.1 `functions/lib/style-store.js`（核心）

**新增 `DEFAULT_STYLE`**——把 `agent/src/prompts/mine.js:29` 的 `MINE_DEFAULT_STYLE` 字面值**逐字符搬来**，作为 canonical 单一真源。

**新增 `ensureStyleSeeded(env, styleKey, legacyKey)`**：

```
1. doc = await readStyleDoc(env, styleKey)
2. 若 doc 存在 → 原样返回 doc（已种过 / 用户已有，幂等不动）
3. 否则检查遗留：legacy = env.FILES.get(legacyKey)
   若 legacy 存在且 parseStyleMarkdown(legacy) 非空 → 返回 null（不种，
   不覆盖老用户；调用方继续走原有 legacy fallback 读取路径）
4. 都没有 → 写 v1：
   writeStyleDoc(env, styleKey, DEFAULT_STYLE, "default")
   返回新 doc（head=1, versions=[{v:1, source:"default", style:DEFAULT_STYLE}]）
```

> 复用现有 `writeStyleDoc`，不另写落库逻辑——`source` 参数已支持任意字符串，传 `"default"` 即可，schema 不变。

**新增 `isDefaultSeed(doc)`**（单一真源的「是否仍是未编辑默认基线」判定）：

```js
// doc 仅有一个版本、是 v1、且来源为 default → 用户还没动过基线
export function isDefaultSeed(doc) {
  return !!doc && doc.head === 1
    && Array.isArray(doc.versions) && doc.versions.length === 1
    && doc.versions[0].v === 1 && doc.versions[0].source === "default";
}
```

> 用「doc 形状」而非「这次请求是否刚种」来判定，于是用户被种后刷新页面仍判为默认基线；一旦编辑成 `v2`（或 restyle/mine 追加版本）自动变 false，语义更准。GET 据此回传 `default` 标记；§6 将来的回灌迁移也复用这同一个判定。

### 4.2 `agent/src/prompts/mine.js`

删掉 `MINE_DEFAULT_STYLE` 的字面定义，改为：

```js
import { DEFAULT_STYLE } from "../../functions/lib/style-store.js";
export const MINE_DEFAULT_STYLE = DEFAULT_STYLE;
```

`mine.js` 的所有下游消费方（`miner.js` 的 `buildMinePrompt`、eval harness）一行不动，拿到的字节完全一致。

> 注：这把默认风格从 mine.js 的「prompt 版本面」挪到 style-store.js。这是**正确的**——种子化之后，生成时的默认回退已极少触发，默认风格本质是「种子数据」而非「prompt 旋钮」。eval 的 `git diff mine.js` 仍覆盖 `MINE_SYSTEM`/`MINE_SYSTEM_FORCE`/`PHOTO_INSTR` 这三个真旋钮；默认文本的改动今后落在 style-store.js 的 git 历史里。

### 4.3 `functions/files/api/[[path]].js`（GET /style，约 :722）

当前：`doc = readStyleDoc(...)`；`doc` 为空 → 走 legacy → 否则 404。

改为：`doc = await ensureStyleSeeded(env, styleKey, legacyKey)`。
- 拿到 doc（刚种的 v1 或用户既有 doc）→ 返回正常形状 `{style, name, head, …}`，并加 **`default: isDefaultSeed(doc)`**（增量字段，老客户端解码只取 `style` 会忽略它；新客户端可据此提示「这是默认王建硕风格，可改成你自己的」。用户编辑成 v2 后该字段自动变 false）。
- 返回 null（遗留用户有内容）→ 落回原有 legacy 分支（:726-730）原样返回他们的文风。
- 仍然没有（理论上 ensureStyleSeeded 总会种，除非 R2 异常）→ 404 兜底保留。

> `GET /style/history`（:735）、`PUT`（:741）、`PATCH /style/head`（:761）**不改**，不种。

### 4.4 `agent/src/miner.js`（主挖文路径，约 :882）

在读 `styleDoc` 之前插入一行 `await ensureStyleSeeded(env, scope + "CLAUDE.json", scope + "CLAUDE.md")`，使后续 `readStyleDoc` 读到刚种的 `v1`。效果：
- 新用户首篇挖文会基于真实的 `v1` 生成，并被打上 `<!-- style: 风格 v1 -->`（现有 `prependStyleComment` + `headV` 逻辑自动生效，阅读页 chip 可显示、可追溯）。
- 遗留用户（CLAUDE.md 有内容）→ ensureStyleSeeded 返回 null 不种，原有 `readStyleText` 的 legacy fallback 照旧。

> `tools.js:188`（agent 视角读风格）本期**不接线**，保持只读；一旦上述任一主路径跑过，它自然读到已种的 `v1`。列为可选后续。

## 5. 测试（`agent/test/style-store.test.js` 新增 5 例）

沿用该文件现有的 in-memory `env.FILES` mock 模式：

1. **空 → 种 v1**：无 CLAUDE.json、无 legacy → `ensureStyleSeeded` 后 doc.head=1，versions[0].source=`"default"`，style===`DEFAULT_STYLE`，且 `isDefaultSeed(doc)===true`。
2. **幂等**：再调一次 → 仍 head=1，不产生 v2。
3. **已有 CLAUDE.json 不动**：先写一个用户 doc（如 head=3）→ `ensureStyleSeeded` 原样返回，head 仍 3，不被默认覆盖。
4. **遗留 CLAUDE.md 有内容 → 不种**：只有 legacy CLAUDE.md（含「# 我的文风」段）→ `ensureStyleSeeded` 返回 null，CLAUDE.json 仍不存在。
5. **`isDefaultSeed` 编辑后转 false**：种 v1 后再 `writeStyleDoc(..., "app")` 追加 v2 → `isDefaultSeed(doc)===false`。

## 6. 已接受的语义后果（D2 展开）

种成 `v1` = **把当前默认风格冻结成该用户的私有副本**。后果两个方向互斥，王建硕已确认接受「物化成 v1」一侧：

| | 物化成 v1（本方案） | 旧的「读时回退」 |
|---|---|---|
| 用户能看到/改基线 | ✅ 能 | ❌ 空框 |
| undo/restyle 有 v1 锚点 | ✅ 有 | ❌ 无 |
| 以后改进代码里的默认风格 | ❌ **只惠及新用户**；已种的存量用户冻在旧版 | ✅ 立刻惠及所有未自定义用户 |

**接受的代价**：以后调优默认王建硕风格，**不会自动回灌给已经种过的存量用户**。

**将来挂点（不在本期实现）**：种下的 `v1` 带 `source:"default"`。将来若要回灌，可加一个迁移——「检测到用户当前 head 仍是未被编辑的 `source:"default"` 版本 → 用新默认覆盖 / 追加」。本期 YAGNI，仅保留这个语义标记以便将来识别。

## 7. 非目标

- 不做默认风格升级的自动回灌迁移（§6）。
- 不给 `tools.js` 的 agent 只读路径接线（§4.4）。
- 不改 PUT/PATCH/history 的行为。
- 不改 schema、不改版本裁剪上限（`STYLE_MAX_VERSIONS`）等既有约定。
