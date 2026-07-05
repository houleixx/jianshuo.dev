# VoiceDrop PhotoTile 支持任意宽高比 — 实施计划（未动手）

日期：2026-07-05
状态：**仅计划，等待批准后实施**

## 难度评估

**中等偏容易。** 没有架构性障碍：paint 服务的 `size` 参数本来就透传任意值
（`paint/src/engine.ts:10`），锁死 1:1 的是上面三层的约定：

| 层 | 位置 | 现状 |
|---|---|---|
| iOS 上传 | `voicedrop/VoiceDropApp/PhotoCapture.swift:553`（SquareImage）、`VoiceDropShare/PhotoComposeView.swift:361`（SquareCrop，复制版） | 中心裁成 1:1，原比例丢弃 |
| iOS 展示 | `voicedrop/VoiceDropApp/RecordingDetailView.swift:951`（PhotoTile） | `.aspectRatio(1)` + `.scaledToFill()` 裁方 |
| Worker | `jianshuo.dev/agent/src/tools.js:260`（postPaintJob，edit_photo/new_photo 共用） | `size: "1024x1024"` 写死 |
| 元数据 | 全链路 | **宽高完全没有留痕**：R2 metadata 不存、`[[photo:KEY]]` 标记不带、API 不返回——客户端下载解码前不知道图多大 |

### 两个关键约束（先认下来再动手）

1. **gpt-image-2 出图只有三档**：1024×1024（方）、1536×1024（横）、1024×1536（竖）。
   AI 编辑后的图只能「贴近」原图比例（snap 到最近一档），不能精确等于。
   原图 4:3 → 编辑后 3:2，瓦片会有轻微比例变化，这是模型侧硬约束，接受它。
2. **占位不跳动**是现有体验的优点（制作中占位和成品同为 1:1，切换无跳动）。
   要保住它，客户端必须**在下载图片前**就知道宽高 → 需要元数据通道。

### 元数据通道的选型（本计划的核心决策）

**把宽高编进对象键名**：上传时生成 `photos/<ts>/<ts>-<rand>-1080x810.jpg`。

- 零 API 改动、零存储 schema 改动：`[[photo:KEY]]` 纯文本标记原样携带尺寸，
  文章 JSON、R2、客户端解析各处都不用加字段；
- 旧键没有尺寸后缀 → 客户端 fallback 按 1:1 渲染，存量方图全部自然兼容；
- 旧客户端看到新键 → 还是当普通 key 下载，`.scaledToFill()` 裁方显示，优雅降级。

备选方案（放弃）：R2 customMetadata + API 加字段——要动文章 API、photos 列表 API、
iOS 模型三处，且 `[[photo:KEY]]` 标记仍不带尺寸，占位还是不知道比例。不如键名法。

---

## 分四步（每步独立可测、可单独上线）

### 第 1 步：上传保留原比例 + 键名带尺寸（iOS，2 处）

- `PhotoCapture.swift`：`SquareImage.jpeg` 改为「长边限 1080、保留比例」（缩略图仍可方，
  见第 2 步说明）；极端全景图钳制比例到 [1:2, 2:1]（超出则中心裁到 2:1 为止），
  防止瓦片变成细长条。
- `PhotoComposeView.swift`（Share Extension）：同改（它是 PhotoCapture 的复制版，注释里已说明）。
- 两处生成对象键时追加 `-<w>x<h>` 后缀（按最终 JPEG 的实际像素）。
- 测试：单测裁剪函数（横图/竖图/全景钳制/小图不放大）；真机上传横竖图各一张，
  确认 R2 里键名带尺寸、字节 <900KB。

### 第 2 步：PhotoTile 按真实比例渲染（iOS，1 处）

- `RecordingDetailView.swift` PhotoTile：从 key 解析 `-<w>x<h>`，
  有 → `.aspectRatio(w/h, contentMode: .fit)`；无 → 维持 1:1（存量兼容）。
- 三个状态（宽限期/制作中/失败）共用同一比例 → 占位与成品尺寸一致，不跳动。
- 成品从 `.scaledToFill` 改 `.scaledToFit`（比例既然对了就不该再裁）。
- 缩略图（264px）继续方形即可——列表场景方图整齐，不在本计划范围。
- 测试：新旧 key 混排的文章渲染；横图/竖图/方图三种占位对齐检查。

### 第 3 步：AI 编辑跟随原图比例（Worker，2 处）

- `tools.js` `postPaintJob`：从源图 key 解析宽高 → snap 到三档
  （ratio > 1.2 → `1536x1024`；< 0.83 → `1024x1536`；否则 `1024x1024`），
  解析不到（旧图）→ 维持 `1024x1024`。
- `makeEditedKey`（`tools.js:225`）：新 key 按 snap 后的输出尺寸带 `-<w>x<h>` 后缀，
  客户端占位一开始就是成品的最终比例。
- `paint-callback`（`index.js:1011`）key 校验正则确认兼容尺寸后缀（`.+` 应已覆盖，写测试钉死）；
  失败分支写原图副本时，newKey 尺寸后缀应等于**原图**尺寸（副本就是原图）——
  这一点在 makeEditedKey 处理失败回退时要注意。
- 测试：Worker 单测 snap 函数三档 + 旧 key fallback；集成一单横图编辑走通回调。

### 第 4 步：收尾与验证

- 真机全链路：拍横图 → 上传 → 文章里横瓦片 → 口述「把它变成广告」→
  制作中占位横比例 → 成品横图落位无跳动。
- 旧文章（存量方图）回归检查。
- README / spec 更新，记录键名尺寸后缀约定（它现在是跨 iOS/Worker 的契约）。

## 工作量估计

- 第 1、2 步（iOS）：合计约半天，纯跟随式改动；
- 第 3 步（Worker）：1–2 小时，含测试；
- 风险点集中在：Share Extension 那份复制的裁剪代码别漏改（两处必须同步）、
  键名后缀成为新契约后 iOS 与 Worker 的解析要用同一条正则约定。

## 明确不做

- 缩略图（264px 列表小图）改比例——列表方图更整齐，没有需求先不动；
- R2 metadata / API 字段方案——键名法已覆盖需求；
- 存量方图的「重制」迁移——fallback 1:1 已优雅兼容。
