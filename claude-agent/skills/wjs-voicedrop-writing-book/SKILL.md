---
name: wjs-voicedrop-writing-book
description: 给一个词、一句话、或一篇文章，长成一本书，增量发布到 R2 公共文件夹（外网免 token 直达），淡雅界面。本 skill 是「书的骨架 + 发布流水线」的总调度：负责工作目录/book.json 结构、认证、build.mjs 渲染与发布、封面、断点续跑、修书模式、编排与红线；而「怎么写」（读者画像、文风、大纲要求、评审维度、写手提示词）按书的类型分派给对应的写作 skill——科普书 wjs-voicedrop-writing-explainary-book / 绘本 wjs-voicedrop-writing-chidrens-book / 小说 wjs-voicedrop-writing-novel。触发词："写一本书"、"把这个长成一本书"、"writing book"、"wjs 写书"、"/wjs-voicedrop-writing-book"。
---

# wjs-voicedrop-writing-book — 一颗种子长成一本书（总调度）

**输入**：一个词 / 一句话 / 一篇文章（任意一种）。
**产出**：一本多章的书，发布到 R2 的 `books/<slug>/` 文件夹，经 **`jianshuo.dev/voicedrop/books/<slug>/`** 公共路由外网免 token 直达，界面淡雅，随写随发。公开入口是 `build.mjs` 跑完打印的那个 `.../voicedrop/books/<slug>/index.html` 链接。最后再走一遍：给全书配一张带书名的封面文件 `cover.jpg`（只是个文件、不嵌正文，供 voicedrop 客户端取用）。

**本 skill 管什么、不管什么**——

- **本 skill（骨架 + 流水线，所有书通用）**：工作目录与 `book.json` 结构、认证、`build.mjs` 渲染/发布、封面、断点续跑、修书模式、编排、发布路由、淡雅界面的两条硬约束、红线。
- **写作 skill（怎么写，按类型分派）**：读者画像、文风铁律、大纲怎么切、写手提示词、评审维度、该类型专属的 HTML 约定与红线。**第 1 步就得选定类型、读进对应写作 skill，后面的建筑师/写手/评审提示词全部从它来。**

先例：`/a/jingangjing/`（金刚经·理工男读本）就是这条流水线跑出来的样子——照它的骨架来。

---

## 第 0 步：选书的类型（分派）

先看种子/主题，判断这本书是哪一类，然后**读进对应写作 skill 的 SKILL.md**，把它的读者画像、文风、大纲要求、写手/评审提示词作为下面所有角色的依据：

| 类型 | 写作 skill | 什么时候选它 |
|---|---|---|
| **科普书 / 讲清一件事** | `wjs-voicedrop-writing-explainary-book` | 想弄懂「它到底怎么运作」——科学/技术/历史/商业/制度的因果与规律。**默认类型**：拿不准、或明显是「讲道理/讲原理」的主题，就选它。 |
| **绘本 / 图画故事** | `wjs-voicedrop-writing-chidrens-book` | 给孩子（或大人）的图画书：图为主、字极简、一个温柔的故事或概念启蒙。 |
| **小说 / 虚构叙事** | `wjs-voicedrop-writing-novel` | 有人物、有情节、有冲突的虚构故事；靠叙事而非说理推进。 |

```bash
# 举例：确定是科普书后，先把该类型的写法读进来
cat ~/.claude/skills/wjs-voicedrop-writing-explainary-book/SKILL.md
```

- **调用方若已在任务里指定了类型**（如 lab 的 /api/book 传了 `type`/`kind`），按它来，别自作主张改类型。
- **没指定就自己判断**；实在拿不准偏向科普书。判断完在 `book.json` 写上 `"type"` 字段（`explainary` / `childrens` / `novel`），`build.mjs` 会据此调整页脚/默认副标注等通用文案。
- 选定后**通篇只用这一种写法**——不要在一本书里混搭三种风格。
- **类目（`category`）也在这一步定**，八选一：`商业` / `投资` / `AI` / `科学` / `人文` / `身心` / `生活` / `故事`。`childrens` 和 `novel` 一律「故事」；科普书按主题：投资偏市场、金钱、估值；商业偏经营、产业、公司史、产品；AI 偏人工智能与软件；科学偏数理、自然、工程科普；人文偏历史、艺术、哲学、制度；身心偏健康、修行、心态、习惯；生活偏吃喝、旅行、玩乐、家事。只能用这八个词，不要自造；不写的书只出现在书架「全部」里，不挂标签。

---

## 四个角色（框架通用，提示词来自写作 skill）

| 角色 | 干什么 | 谁来当 |
|---|---|---|
| **建筑师 architect** | 把种子拆成一本书的大纲：书名、slug、切入角度、章节清单（每章一句 brief）、配色 | 1 个 agent |
| **写手 writer** | 每章一个，写正文 HTML 片段 | N 个 subagent，**并行** |
| **评审 reviewer** | 独立按该类型的维度判过不过，给反馈 | 每章 1 个 subagent，**不能是该章的写手** |
| **发布 publisher** | 把过审章节组装成淡雅页面，增量发到 R2（经 `/voicedrop/books/` 公开） | 你（主循环）跑 `build.mjs` |

**框架是通用的，提示词是分类型的**：建筑师怎么切大纲、写手守什么文风、评审看哪几个维度——全部从第 0 步读进来的写作 skill 取。这里只规定机制：

- 评审必须**独立**：单独 spawn，只喂它「章节成品 + 全书大纲」，**不喂写手的思路**，让它从零判断；存疑处让它自己查（web / Explore）。
- 写手与评审**绝不共享上下文**。
- 写→评→（不过则**换新写手**照 `must_fix` 重写）→复审，**最多 3 轮**；3 轮仍不过就降级该章（缩小野心）或记录短板后放行，别死循环。

---

## 认证（复用 wjs-voicedrop）

发布走用户自己的 token（`~/.config/voicedrop/credentials`）。没有就先按 `wjs-voicedrop` 的 6+4 登录拿到。`build.mjs` 会自己读这个凭证，你不用手动传。

---

## 工作目录约定

在**当前目录**（agent 的 cwd，即 `/opt/claude-agent/workspace/`）下的 `book-<slug>/` 攒稿——
**不要用 /tmp**（服务开了 PrivateTmp，重启就没了；workspace 是耐久盘，修书模式还要回来用）：

```
book.json            # 全书清单（见下），随进度更新
intro.html           # 导读正文 HTML 片段（可选）
chapters/01.html     # 第 1 章正文 HTML 片段（<article> 里面的内容）
chapters/02.html
...
reviews/01.json      # 第 1 章的评审意见（留痕，便于重写）
```

### book.json 结构

```json
{
  "jobId": "（调用任务里给的 jobId，原样抄进来——服务端登记簿靠它对号，漏了这本书就没有主人）",
  "owner": "（调用任务里给的 owner scope，原样抄进来——产权真源，谁能在线修改这本书以此为准；服务端也会兜底补）",
  "type": "explainary",                    // explainary | childrens | novel，决定通用文案（页脚/默认副标注）；缺省当 explainary
  "category": "科学",                       // 书架类目，八选一：商业 / 投资 / AI / 科学 / 人文 / 身心 / 生活 / 故事（见上面「类目」一条）
  "slug": "entropy",                       // 决定 books/<slug>/ 文件夹与 /voicedrop/books/<slug>/ 路径；小写、连字符、别撞已有的
  "title": "熵：为什么一切都在变乱",
  "subtitle": "从洗牌到宇宙热寂，一个工程师能摸到的无序",
  "author": "（调用任务里给的署名）",        // 只用调用方传进来的作者名；没给就整个不写这个字段，不要默认署「王建硕」
  "meta": "面向理工背景的好奇者",           // 目录页副标注，可选（缺省按 type 给中性文案）
  "tagline": "费曼式写法 · 由多个 AI 代理撰写与互相审校",  // 页脚小字，可选（缺省按 type 给中性文案）
  "tint": "#e9eef0",                       // 强调浅底色，随主题气质调
  "dark": "#2f6d7a",                       // 强调深色（标题/序号/重点），随气质调
  "introTeaser": "先别背公式，先想想一副新牌。",  // 目录页导读钩子，可选
  "chapters": [
    {"no": 1, "title": "第一章 · 一副新牌", "brief": "用洗牌讲清什么叫无序", "status": "done"},
    {"no": 2, "title": "第二章 · 时间的箭头", "brief": "为什么鸡蛋不会自己拼回去", "status": "writing"},
    {"no": 3, "title": "第三章 · 麦克斯韦的小妖", "brief": "信息就是能量", "status": "planned"}
  ]
}
```

`status`：`planned`（待写）/ `writing`（在写）/ `done`（过审已发）。目录页据此显示，只有 `done` 的章节可点开。
顶层还可写 `"hidden": true`——书不上书架（index 的 HTML/JSON 都不出），但文件照发、直链可看。**绘本（`type: "childrens"`）创建时缺省必须带 `"hidden": true`**（服务端也会兜底补），主人验收后修书去掉即上架；其他类型缺省不写。
`title`/`subtitle`/`meta`/`tagline`/`tint`/`dark`/`introTeaser` 的**气质与措辞由所选写作 skill 决定**——科普书是费曼式、绘本是童趣、小说是文学感；`build.mjs` 只在你没写这些字段时按 `type` 兜一个中性缺省。

---

## 流水线（按顺序，但**边写边发**）

> 下面每一步里，「建筑师怎么切大纲」「写手守什么文风、用哪些标签」「评审看哪几个维度」都以第 0 步读进来的写作 skill 为准；这里只讲通用节拍与命令。

### 1. 建筑师写大纲（1 个 agent）

按写作 skill 的大纲要求 spawn 一个 agent，产出：书名、slug、subtitle、切入角度、章节清单（每章 `no / title / 一句 brief`）、tint/dark 配色、一句 introTeaser。把结果落成 `book.json`（全部章节先标 `planned`；写上 `type` 和 `category`）。

### 2. 先发一个骨架（第一次「有进展就发」）

```bash
node ~/.claude/skills/wjs-voicedrop-writing-book/build.mjs index book-<slug>
```

目录页此刻就上线了（章节显示「待写」）。**之后每完成一点都重发一次。**

### 3. 每章：写 → 评 →（不过则重写）→ 发

对每一章跑这个循环。**多章可并行**：一条消息里 spawn 多个写手；写完各自进各自的评审。

- **3a. 写手 subagent**：提示词按写作 skill 给（读者画像 + 文风铁律 + 该类型的 HTML 约定 + 长度）。产出**一段 `<article>` 里面的 HTML 片段**，存到 `chapters/NN.html`。通用硬约束（所有类型都守）：不写 `<h1>`（标题由模板出）；不写内联 `style`；不编造图片 URL；内链一律相对文件名。
- **3b. 评审 subagent（独立！另 spawn）**：只喂「该章成品 HTML + 全书大纲」，按写作 skill 的评审维度打分并给 `must_fix`，输出 JSON 存 `reviews/NN.json`（约定字段：`{"scores":{...},"verdict":"pass|fail","must_fix":["…"],"note":"一句总评"}`）。
- **3c. 不过就重写**：把 `must_fix` 交给一个**新的**写手 subagent（别复用原写手上下文），照单重写 `chapters/NN.html`，再回 3b 复审。最多 3 轮。
- **3d. 过了就发**（**落盘即发，绝不攒到最后**）：
  ```bash
  # 先把过审正文写到 chapters/NN.html（落盘=durable 检查点），然后一步到位：
  node ~/.claude/skills/wjs-voicedrop-writing-book/build.mjs done book-<slug> NN   # 标 done + 落 book.json + 发该章 + 刷新目录
  ```
  `done` 把「改状态 / 发该章 / 刷目录」合成一次原子操作。读者立刻能读到新章，目录 `x/N` 前进。

> **为什么必须每章即发**：正文一旦落到 `chapters/NN.html` 且 `build.mjs done` 过，这一章就**永久在盘上、且已上线**——哪怕会话被切断、workflow 崩了，都不影响已发的章。这是长书的抗断点设计。**绝不**把整本攒到最后一次性发。

### 3.5 断点续跑（长书必看）

磁盘就是检查点。任何时候被打断，回来先跑一句看还差哪些：

```bash
node ~/.claude/skills/wjs-voicedrop-writing-book/build.mjs status book-<slug>   # 列出每章 done / 待发(有稿) / 待写
```

- `✓ done`：已上线，别重写别重发。
- `· 待发(有稿)`：正文已落盘但没发 → 直接 `build.mjs done <NN>`。
- `待写`：才需要重新走 写→评→发。

**据此只补没做的章，绝不从头重来。**

> **恢复演练（被切断后先做这三步，别急着重写）**：
> 1. **R2 才是「已发布」的最终真相**——`status` 只读本地 `book.json`，两者可能错位。先直接探 R2：
>    `for n in $(seq -w 1 16); do echo -n "$n "; curl -s -o /dev/null -w '%{http_code}\n' https://jianshuo.dev/voicedrop/books/<slug>/$n.html; done`（200=已发、404=没发）。
> 2. **对账**：R2 有的 = 真 done，别重发；本地有稿但 R2 404 = 直接 `build.mjs done NN` 补发（先抽读一章确认质量再批量发）；本地无稿且 R2 404 = 才真要重新走 写→评→发。
> 3. **本地全空但 R2 有章** = 环境被重置：用「修书模式」的 `build.mjs pull` 从线上源稿镜像拉回，再只补 404 的章。

### 4. 导读页（可选，建议有）

全书过半后，按写作 skill 的导读要求写 `intro.html`（也走写→评），发：
```bash
node ~/.claude/skills/wjs-voicedrop-writing-book/build.mjs intro book-<slug>
```
并在 `book.json` 里填 `introTeaser`，重发 index。

### 5. 收尾

全部 `done` 后再发一次 index（`build.mjs index` 或 `all`）。把它打印出来的公开链接
`https://jianshuo.dev/voicedrop/books/<slug>/index.html` 给用户——外网可直接打开。

---

## 修书模式（书写完后，主人在 App 里持续修改）

调用方（lab /api/book/revise）会给你 **slug** 和主人的**修改指令**。铁律：**文件是真源，不是记忆**——一切以工作目录 + 线上成书为准。

1. **重建/复用工作目录**：`ls book-<slug>/book.json` 在就直接用；不在就
   `node ~/.claude/skills/wjs-voicedrop-writing-book/build.mjs pull book-<slug> <slug>`
   从线上 `_src` 源稿镜像拉回（book.json + 各章片段 + 导读 + 封面）。
   pull 报「没有 _src」= 源稿镜像上线前的老书：手工重建——抓渲染页各页 `<article>…</article>` 里的正文片段存 `chapters/NN.html`，按目录页信息手写 book.json（全部标 done），再继续。
2. **先读 book.json 认出类型**（`type` 字段），把对应写作 skill 读进来，再动手；改内容要守该类型的文风与评审。只改与指令相关的文件，无关章节**一个字都不动**。
3. **大改保持水准**：新增/重写整章仍走「写→独立评审→不过重写」；小改（错别字/换说法）直接改。淡雅界面两条硬约束照旧。
4. **改完即发**：动过的章逐章 `build.mjs done book-<slug> NN`；只动 book.json/导读就 `index`/`intro`；换封面就 `build.mjs asset book-<slug> cover.jpg cover.jpg`。
5. **收尾输出「修改说明」**：最后一条消息只输出一段 200 字以内、给书的主人看的说明——改了什么、动了哪几章、为什么。会原样进 App 的修改记录，别写寒暄/内部术语。

---

## 发布机制：/voicedrop/books/ 公共路由（要点，别抄错）

`build.mjs` 把整本书发到 **R2 的 `books/<slug>/` 文件夹**（写走 files API：`PUT /files/api/upload/books/<slug>/<file>`，`Content-Type: text/html`），经 **`jianshuo.dev/voicedrop/books/<slug>/`** 这个专门的公开只读路由外网直达。

- **页面结构**：`books/<slug>/index.html`（封面+目录）、`intro.html`（导读）、`01.html…NN.html`（每章一页）。用真 `.html` 文件、真 `text/html` 类型。
- **路由特性**：免 token、**`no-store` 不缓存**，所以**重发即刷新**，不需要 `?v=` 破缓存。该路由只读（直接 PUT/POST 会 405）。
- **内链**用相对文件名 `NN.html`；`build.mjs` 打印的公开入口是完整 URL。
- ⚠️ **读写要对上同一个 store**：写入落在**本账号 scope** 的 `books/<slug>/`。若发完访问 `/voicedrop/books/<slug>/index.html` 是 404，多半是该路由指向了别的 store——这是后端配置，把本账号 scope（`GET /files/api/whoami`）告诉后端去对齐即可。

---

## 淡雅界面（已内建在 build.mjs，所有类型通用）

暖米纸底（`#f7f2e7`）+ 宋体正文 + 单一强调色（随书 `tint/dark` 走）+ 720px 阅读栏 + 大行距。目录页是章节清单带进度徽标；章节页有上/下章导航和回目录。要换气质**只调 `book.json` 的 `tint/dark`**，别在正文片段里写内联样式。改版式才动 `build.mjs` 里的 `CSS`。

**两条不可回退的硬约束**（改 `build.mjs` 时务必守住）：

1. **内链一律相对**：内链只写文件名 `href="01.html"`、`href="index.html"`；回书架用 `href="../"`。**绝不写** `/voicedrop/books/<slug>/…` 根绝对路径——它在 voicedrop.cn（EO 剥前缀）上每次点击会多一次 301。`build.mjs` 里 `linkPath()` 已返回纯文件名，别改回带前缀。
2. **零外部资源**：页面**不引任何外部 CSS/JS/字体/CDN**（尤其 **Google Fonts**）——国内读者会超时白屏。字体只靠 CSS 里的系统字体栈兜底。`build.mjs` 的 `head()` 里已无字体外链，保持这样。

> 说明：CSS 里带了通用件（如 `.plain` 大白话盒子、`dfn` 虚下划线），是**按需使用**的——某类型（如科普书）用得上就用，用不上（如小说）不写这些标签即可，不影响其它类型。

---

## 第 6 步：最后一遍——封面（+ 必要时插图）

**所有图片一律用 `/opt/claude-agent/bin/paint`（背后是 GPT 出图）生成**，timeout 设 600000ms。**绝不用任何本地生图/改图/叠字工具**（ImageMagick、PIL、canvas、自绘字…全禁）——包括封面上的文字，也让 GPT 直接画进图里。图片用 `build.mjs asset` 上传，内链一律相对，遵守两条硬约束。

> **插图密度按类型走**：科普书默认**不配**插图（除非某概念不画就讲不清）；绘本**以图为主**、几乎每页都要图；小说一般不配图或只配少量氛围图。具体规则见各写作 skill。这里只讲通用的封面。

### 封面 cover.jpg（每本都要，但只是个文件）

一张竖版封面，存成 `<workdir>/cover.jpg`、用 `build.mjs asset` 传成 `books/<slug>/cover.jpg`。

- **它只是放在书目录里的一个文件，供别的工具（voicedrop 客户端）取用显示——不嵌进正文页/目录页**（`build.mjs` 不会把它渲染进任何 HTML）。
- **必须有明显的书名**，有作者就写上作者；文字放在**抽象背景的空白区之上**。让 GPT 直接把文字画进图：提示词里描述抽象背景（随书配色、留白充足）+ **一字不差列出**书名/副标题/作者，并写明「画面上只允许出现这些文字，不要多余字符/水印/乱码」。中文书名 GPT 能画准，糊了就重跑或精简书名。
- **默认大标题排版**：整张封面**以文字为主角**——主标题非常大、粗、占据上部约满宽（长了分两行）；副标题约为主标题一半大小、紧跟其下；作者中等、底部居中。背景退为衬托。
- **尺寸固定用 `--size 1024x1536 --format jpeg`（竖版 1:1.5）**。gpt-image 只吃 `1024x1024`/`1024x1536`/`1536x1024` 三种，别乱填。

封面/插图都是最后一遍，别打乱正文「过审即发」的节奏。风格拿不准参考 `wjs-voicedrop-choosing-cover`（淡雅、浅底、别廉价海报感），封面气质也随书的类型走。

---

## 编排：默认主循环并行，Workflow 只是「会话稳定时」的加速档

**最抗中断的编排 = 主循环里直接并行 spawn，不是 Workflow。** 一条消息里同时 spawn 多个写手 / 多个独立评审，它们在**这一个回合内**返回；主循环随即逐章 `build.mjs done NN` 落 R2。要点：**每一步都在单个回合内跑完、且在回合结束前落成持久状态——没有在飞的工作跨越会话边界。** 典型节拍：① 主循环 spawn 全部写手（各自落盘 `chapters/NN.html`）；② spawn 全部独立评审（各自读稿、核实、写 `reviews/NN.json`、返回 pass/fail）；③ 把 pass 的章一条 `for` 循环 `build.mjs done` 发掉，fail 的当场 spawn 新写手重写再复审。

**为什么不首选 Workflow**：`Workflow` 跑在后台、命寿绑在当前会话进程上。会话超时 / 容器回收 / 回合切换销毁进程时，正在跑的 workflow 就成孤儿、没有完成记录。**保证的从来不是「进程不被切」（做不到），而是「切了也无损」**：把工作切成每章一个能在单回合落到 R2 的持久检查点。

**什么时候仍可用 Workflow**：会话明显稳定、或书较短（≤6–8 章、评审宽松、几分钟能跑完）时。用就必须守两条：① Workflow 脚本沙箱**没有文件系统**，「落盘+发布」只能由能碰盘的 agent 或主循环做，不能写在纯 JS 里；② 别把整本攒到 workflow 最后一次性 return。因此让**发布发生在每章过审的当下**：

- **A（推荐）· 分批 + 主循环发**：一批 3–5 章，用 Workflow 跑出过审 HTML 返回；主循环立刻逐章落盘 + `build.mjs done NN`。一批 = 一个 durable 检查点。
- **B · pipeline 里加发布 agent**：publish stage 里用能碰盘的 agent 写盘 + `build.mjs done NN`。

```
phase('大纲');  const book = await agent(architectPrompt, {schema: BOOK_SCHEMA})   // architectPrompt 来自写作 skill
// 主循环：落 book.json + build.mjs index（骨架）
await pipeline(batchOf(book.chapters),
  ch  => agent(writerPrompt(ch, book), {phase:'写作'}),                 // writerPrompt 来自写作 skill
  (html, ch) => reviewLoop(html, ch, book),                            // 评审维度来自写作 skill，最多3轮
  (html, ch) => agent(publishPrompt(ch, html), {phase:'发布'}))        // 发布 agent：写盘 + build.mjs done NN
```
评审用独立 agent、adversarial。**磁盘（`chapters/NN.html` + book.json）才是真检查点**——断了就 `build.mjs status` 看还差哪些，只补没做的。

---

## Red Flags（通用；踩到就退回。文风类红线见各写作 skill）

- 没先选类型 / 没把对应写作 skill 读进来就开写 → 建筑师和写手会跑偏，回第 0 步。
- 一本书里混搭多种风格（一半科普一半小说腔）→ 选定一种通篇执行。
- 评审和写手是同一个 agent / 共享了上下文 → 不算独立，重来。
- 全写完才发第一次 → 违反「有进展就发」，发完骨架就上线、每章过审即发。
- 把整本攒到一个长 workflow 最后一次性 return / 一次性发 → 长书会话切换会全丢。必须每章过审即 `build.mjs done NN`；长书**分批**跑。
- 长书首选长时后台 Workflow / 以为进程会连续活到跑完 → 会话被切就成孤儿。长书**默认走主循环并行 spawn + 每章前台即发**。
- 被打断后从头重跑 → 先探 R2（curl 各章 200/404）再 `build.mjs status` 对账，只补没做的。别只信本地 `status`。
- 死循环重写 >3 轮 → 降级该章，记录短板，放行。
- 发完 `/voicedrop/books/<slug>/index.html` 还是 404 → 不是没发成，是路由没读本账号的 `books/` 前缀（读写 store 没对上）；`PUT /files/api/upload/books/...` 返回 200 就算成功，别反复重传，去对齐后端。
- 直接对 `/voicedrop/books` 发 PUT/POST → 405，它只读；写一律走 `/files/api/upload/books/...`。
- 正文片段里写内联 `style` / `<h1>` → 破坏淡雅基调，交给模板。
- 内链出现根绝对路径 `/voicedrop/books/…` → 违反硬约束 1，改回相对文件名。
- 页面出现 Google Fonts 或任何外部 CSS/JS/字体 → 违反硬约束 2，删掉、只用系统字体栈。
- 用了本地生图/改图/叠字工具 → 违反「图片全走 paint(GPT)」，重做；封面文字也让 GPT 画进图。
- 把 cover.jpg 渲染进正文/目录页 → 封面只是文件、供别的工具取用，不进 HTML。
- 封面没有清晰可读的书名 → 不合格，重画。

---

## 依赖

- `build.mjs`（本目录，Node ≥ 20）：组装淡雅页面 + 发布到 R2 `books/<slug>/`（经 `/voicedrop/books/` 公开、打印公开链接）。所有书类型通用。
- 写作 skill（按类型选一个读进来）：`wjs-voicedrop-writing-explainary-book`（科普书）/ `wjs-voicedrop-writing-chidrens-book`（绘本）/ `wjs-voicedrop-writing-novel`（小说）。
- 认证：`wjs-voicedrop`（`~/.config/voicedrop/credentials`）。
- 可选：`/opt/claude-agent/bin/paint`（配图）、`wjs-voicedrop-choosing-cover`（配图风格）。
