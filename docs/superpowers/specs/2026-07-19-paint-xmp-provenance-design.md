# paint 出图自带 XMP 溯源 — design

日期：2026-07-19 · 状态：已批准（对话中逐点定稿）

相关既有 spec：`2026-07-01-paint-*`（paint 服务本体）、
voicedrop repo `2026-07-11-prompt-share-magic-number-design.md`（7 位魔法数字）、
`2026-07-02-voicedrop-dictate-photo-edit-design.md`（edit_photo → paint 回调链路）。

## 问题

gpt-image-2 的输出不带 EXIF、不带 prompt——只有 OpenAI 的 C2PA 防伪章（且被任何
重编码剥掉）。paint 出的图落地后就是裸文件：日后无从知道哪个 prompt 生成的、
哪条指令（魔法数字）出的。溯源要靠旁边另存 `cover-prompt-used.txt` 之类的
sidecar，文件一挪就散。

## 目的（已裁决：溯源 + 传播都要）

1. **溯源**：每张图文件内自带 prompt 原文、job_id、模型、时间——复盘调优不求人。
2. **传播**：调用方可附加 VoiceDrop 指令的 7 位魔法数字。图的原文件走到哪
   （网盘 / 文件传输 / 下载原图 / AirDrop），「同款指令」的兑换码就跟到哪。
   已知边界：微信/小红书等平台上传会重压缩、剥掉全部 XMP——码只在原文件场景
   存活，接受；本期**不做**图面可见水印（图面零污染，可见化将来另做一期）。

## 决定

### 1. 写入点：paint 服务统一写，出图之后、回调之前

所有 paint 出图（网页 / prompt-lab / VoiceDrop / 任何 API 调用方）一律在服务端
写入。下游拿到的 `result_url` 已是带元数据的文件。回调契约零变化。

- **已弃方案**：调用方各自写（VoiceDrop worker 回调后写）——网页 / prompt-lab
  的图不带档案，且 Cloudflare Worker 里写二进制块得再实现一遍。

### 2. API 契约：`POST /api/jobs` 加两个可选字段

```
xmp_prompt?: boolean   // 默认 true：prompt 全文写入 dc:description；敏感链路传 false
xmp_meta?:   object    // 自定义字段，如 {"magic":"1234567","source":"prompt-lab"}
```

- `xmp_meta` 只收字符串值；key 限 `^[A-Za-z0-9_]{1,32}$`；序列化总量封顶 4KB，
  超限整个请求 400（宁缺勿错，别静默截断）。
- **魔法数字不特殊处理**——就是 `xmp_meta` 里一个普通 key。paint 不懂
  VoiceDrop 业务，边界干净。
- 老调用方零改动；不传参数 = 默认行为（prompt 全文入档，无附加字段）。

### 3. XMP 内容

标准字段（通用工具都认）：

| 字段 | 值 |
|------|----|
| `dc:description` | prompt 全文（`xmp_prompt:false` 时省略整个字段） |
| `xmp:CreatorTool` | `gpt-image-2 via paint.jianshuo.dev` |
| `xmp:CreateDate` | 出图时刻 ISO 8601 |

自定义命名空间 `paint:`（URI `https://paint.jianshuo.dev/ns/1.0/`）：

| 字段 | 值 |
|------|----|
| `paint:JobId` | job uuid |
| `paint:Model` | 模型名（gpt-image-2） |
| `paint:<Key>` | `xmp_meta` 逐 key 映射（key 首字母转大写，如 `magic` → `paint:Magic`） |

所有值 XML 转义。读取端 `exiftool 图.png` 一行全出；将来「从图识码」只需读
这一个标准位置。

### 4. paint 内部实现

新增 `src/xmp.ts`（纯 node 零依赖，约 150 行，延续 paint 的零依赖哲学）：

- `buildXmp(fields)` — 拼标准 xpacket XMP 包。
- `embedXmp(path, xmp)` — 按文件格式插入：
  - **PNG**：IHDR 之后插 `iTXt` 块，keyword `XML:com.adobe.xmp`，自算 CRC32。
    （2026-07-19 已在本机用零依赖 python 原型验证过该路径：插入后 sips 读图完好、
    XMP 可读回。）
  - **JPEG**：SOI 之后插 APP1 段，头 `http://ns.adobe.com/xap/1.0/\0`。
  - **WebP**：本期跳过（要动 VP8X 标志位，现有链路全是 PNG，YAGNI），
    跳过时 log 一行。
- 写入 = 临时文件 + rename，原子落盘。

worker.ts 流程：CLI 出图 → `embedXmp` → 标记 done → 发回调。
**元数据写入失败绝不让任务失败**：catch 后 log，照常回调，图无非裸奔一张。

### 5. 调用方接入（本期只定契约，接线各自后续做）

- **prompt-lab**（voicedrop-agent 代理端点）：转发时带
  `xmp_meta: {source:"prompt-lab", prompt_id:"<注册表id>", magic?:"<7位码>"}`，
  指令有活跃分享码就带上。
- **VoiceDrop edit_photo**：建议 `xmp_prompt:false`（口述蒸馏 prompt 属用户隐私，
  图会被分享出去）+ `xmp_meta: {source:"voicedrop"}`。
- **网页手动出图**：不传即默认，prompt 全文自动入档。

### 6. 测试

- 单测（node:test，随现有测试跑）：PNG 插块后 CRC/结构合法；JPEG 段长度正确；
  XML 转义（引号/尖括号/中文）；`xmp_meta` 超限 400、坏 key 400。
- 集成：真跑一张图 → 独立解析读回全部字段逐一断言 → `sips`（或 PNG 头解析）
  确认图片可打开。
- 部署后验证：VPS 上出一张真图，exiftool 或解析脚本读回。

## 非目标

- 图面可见水印 / 角落小字（将来另做一期）。
- WebP 写入。
- 对抗平台压缩的隐写水印。
- 修改回调 body 或 result 命名。
