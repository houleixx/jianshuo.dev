# VoiceDrop 三预设文风（新用户默认）设计文档

日期：2026-07-05
状态：设计已获批准，待实施

## 目标

给 VoiceDrop **新用户**默认提供三种文风预设——王建硕风格、小红书风格、公众号风格，
开局就是可用的 v1/v2/v3 版本链，各自可编辑。用户不必先蒸馏就有能挑的风格。

## 已定决策（brainstorm 结论）

- **预设与用户文风的关系**：B 档——预设作为**种子拷进每个用户自己的版本链**
  （不是系统级只读库）。开局 v1 王建硕 / v2 小红书 / v3 公众号，用户可各自编辑。
- **生效范围**：A 档——**只对新用户生效**。存量 105 用户（已有 CLAUDE.json）完全不动，
  不补齐、不覆盖。他们想要另两种得自己蒸馏或日后手动补（不在本次范围）。
- **开局生效版本**：`head` 指向 **v1 王建硕**（维持现有默认嗓音）。
- **预设 chip 角标**：暂不做（YAGNI）。chip 名字取风格正文首行即可区分，见「iOS 层」。

## 现状（调研结论，改动基于此）

- 文风存 `users/<sub>/CLAUDE.json`，schema-3 信封：`{schema:3, head, versions:[{v,savedAt,source,style}], profile?}`。
- 现在只有一个内置 `DEFAULT_STYLE`（=王建硕风格，`functions/lib/style-store.js:27`）。
- `ensureStyleSeeded`（同文件 :41）：新用户首次触碰文风时，种一个 v1（`source:"default"`）。
- `isDefaultSeed`（:54）：判断「还是未编辑的种子」——现在写死「恰好 1 版、v1、source default」，
  GET /style 用它给 UI 一个 `default` 标志（提示用户去蒸馏）。**三预设后这个判断要改。**
- 挖矿注入（`miner.js` 的 `<style>` 块）+ 多风格对比（`profile.styles` ≤3，各挖一篇）**已存在**，
  三预设复用这条通路，无需改注入层。
- iOS `SettingsView.swift`：版本链显示、切 `head`、编辑均已支持；chip 名取风格首行（`StyleNaming`）。

## 改动设计

### 数据层 `functions/lib/style-store.js`（单一真源）

1. 保留 `DEFAULT_STYLE`（王建硕），新增两个常量 `XHS_STYLE`、`WECHAT_STYLE`（文本见下节），
   再导出一张有序预设表：
   ```
   PRESET_STYLES = [
     { name:"王建硕", style: DEFAULT_STYLE },
     { name:"小红书", style: XHS_STYLE },
     { name:"公众号", style: WECHAT_STYLE },
   ]
   ```
   王建硕仍是挖矿回退单一真源（`mine.js` 的 `MINE_DEFAULT_STYLE` 继续 re-export `DEFAULT_STYLE`，不变）。

2. 新增 `seedPresetDoc()` 纯函数（构造三版信封，便于单测，不碰 IO）：
   ```
   seedPresetDoc(now) -> {
     schema:3, head:1,
     versions:[
       {v:1, savedAt:now, source:"preset", style:DEFAULT_STYLE},
       {v:2, savedAt:now, source:"preset", style:XHS_STYLE},
       {v:3, savedAt:now, source:"preset", style:WECHAT_STYLE},
     ],
     createdAt:now, updatedAt:now,
   }
   ```

3. `ensureStyleSeeded` 改为：新用户（无 CLAUDE.json、无 legacy 文风）时写 `seedPresetDoc(Date.now())`
   而不是单版 `DEFAULT_STYLE`。存量分支（`doc` 已存在 / legacy 有文风）**一字不改**——保证 A 档。

4. `isDefaultSeed` 泛化为 `isPresetSeed(doc)`：三版、v1/v2/v3、`source` 全 `"preset"`、head=1 →
   true。保留旧名 `isDefaultSeed` 作 alias 或让 GET /style 改调用点（取最小改动，见实施计划）。
   语义仍是「还是原样未编辑的预设，UI 可提示可蒸馏可自定义」。

### 注入层 `agent/src/miner.js`

无需改。用户选哪个 `head` 就用哪个；`profile.styles` 多风格对比天然能选中三预设各挖一篇。

### iOS 层 `VoiceDropApp/SettingsView.swift`

无需改。三版进来自动显示成 v1/v2/v3，chip 名字取各自风格首行（会显示成「王建硕…」「小红书…」
「公众号…」的首行摘要）。多风格对比选择 UI（≤3）已在，可直接选中三预设。
（可选后续：给 `source:"preset"` 的版本加「预设」小角标——本次不做。）

## 两段新预设文本（草稿，逐字待用户过目）

格式与 `DEFAULT_STYLE` 一致——写作规则清单，不是范文。

### 小红书风格 `XHS_STYLE`
```
小红书笔记体：短句、口语、有网感，一段最多两三行，读着像跟朋友唠。
开头第一句就抛钩子——痛点、反差或一个具体数字，别铺垫。
每张卡 / 每段只讲一个点，多用「你」，像当面说话。
适度用 emoji 点睛（一段零到两个，别每行都堆），亲切但不发嗲、不喊「宝子家人们」。
能列点就分行列，别写成大段。
结尾带三到五个话题标签（#xxx），挑跟内容真相关的。
不写「首先/其次/综上」，不写书面腔。
```

### 公众号风格 `WECHAT_STYLE`
```
微信公众号文章体：比口语更完整、比论文更亲切，面向广泛读者，不特指某一个人的嗓音。
开头直接进入话题、给出这篇要解决的问题，第一段就立住价值，不用小白式提问钩子。
用清晰的小标题分段，每段有节奏，长短句交替，读着不累。
观点先行、例证跟上；细节能列表就列表，不在叙述句里堆。
结尾留一句有回味的话或一个可带走的要点，不强行升华、不喊口号。
不堆 AI 味连接词（首先/其次/综上所述/值得注意的是），emoji 克制或不用。
```

## 测试

`functions/lib/` 现有测试风格（对照 style-store 已有单测）：
- `seedPresetDoc(now)`：三版、v 号连续 1/2/3、head=1、source 全 `preset`、三段 style
  分别等于三个常量、时间戳落位。
- `ensureStyleSeeded` 新用户：无 doc、无 legacy → 写出的 doc 通过 `isPresetSeed`。
- `ensureStyleSeeded` 存量用户：已有 doc → 原样返回，**不被三预设覆盖**（A 档回归）。
- `ensureStyleSeeded` legacy 用户：legacy 有文风 → 返回 null，不种（维持现有行为）。
- `isPresetSeed`：三预设种子 → true；用户编辑过（多一版 / source 非 preset / head≠1）→ false。

## 明确不做

- 给存量 105 用户补齐预设（A 档明确排除）
- 预设 chip「预设」角标（YAGNI，可选后续）
- 系统级只读预设库、预设集中更新（B 档已否决 A 档方案）
- 改挖矿注入层、iOS 文风 UI（现有通路已覆盖）
- 碰 `WECHAT.json`（那是公众号发布配置，与文风无关）
