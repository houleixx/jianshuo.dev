// src/ui-config.js — 长按菜单等 UI 配置的服务端真源。
// spec: voicedrop repo docs/superpowers/specs/2026-07-04-longpress-actions-menu-design.md
//
// 形状按页面命名空间组织（pages.<page>.<interaction>.<node>），v1 只有 voice-editor
// 一页的 longpress.image / longpress.text 两节。占位符 {{KEY}}/{{LINE}}/{{QUOTE}}
// 全部由客户端替换后经语音编辑通道下发，指令是普通中文文本。
//
// 真源 = 这里的字面量；R2 `config/ui-config.json` 存在且解析为带 schema+pages 的
// 对象则整体覆盖（照 community-blocklist 先例）。改 R2 = 零部署调菜单/文案。
export const DEFAULT_UI_CONFIG = {
  schema: 1,
  pages: {
    "voice-editor": {
      longpress: {
        image: {
          groups: [[
            {
              id: "style", label: "图片风格", type: "submenu",
              children: [
                { id: "cartoon", label: "卡通", instruction: "把这张图（[[photo:{{KEY}}]]）重画成宫崎骏动画的手绘卡通风格，构图和主体不变，正文其他内容都不要动。" },
                { id: "ad", label: "广告", instruction: "把这张图（[[photo:{{KEY}}]]）重新设计成一则商品广告。请从专业设计师的角度，结合本篇文章的内容和受众，打造一个精致、洗练的视觉设计。整体风格要现代、极简，不使用文字，可以加一些别的代替文字的元素。请通过合理的版式构成，最大限度地突出商品的魅力。正文其他内容都不要动。" },
                { id: "watercolor", label: "水彩", instruction: "把这张图（[[photo:{{KEY}}]]）重画成通透的水彩画风格，构图和主体不变，正文其他内容都不要动。" },
                { id: "sketch", label: "素描", instruction: "把这张图（[[photo:{{KEY}}]]）重画成铅笔素描风格，构图和主体不变，正文其他内容都不要动。" },
                { id: "oil", label: "油画", instruction: "把这张图（[[photo:{{KEY}}]]）重画成古典油画风格，构图和主体不变，正文其他内容都不要动。" },
                { id: "film", label: "胶片", instruction: "把这张图（[[photo:{{KEY}}]]）调成胶片摄影的质感和色调，构图和主体不变，正文其他内容都不要动。" },
              ],
            },
          ]],
        },
        text: {
          groups: [[
            {
              id: "rewrite", label: "改写这段", type: "submenu",
              children: [
                { id: "concise", label: "更简洁", instruction: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更简洁，意思不变，正文其他行都不要动。" },
                { id: "casual", label: "更口语", instruction: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更口语、像平时说话，意思不变，正文其他行都不要动。" },
                { id: "formal", label: "更书面", instruction: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更书面、更正式，意思不变，正文其他行都不要动。" },
                { id: "expand", label: "扩写一点", instruction: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）扩写一点，补充细节但别啰嗦，正文其他行都不要动。" },
              ],
            },
          ], [
            {
              id: "insert", label: "插入图片", type: "submenu",
              children: [
                { id: "wechat-cover", label: "公众号题图", instruction: "给这篇文章画一张微信公众号题图，放在文章最前面。画面为 2.45:1 的横幅比例。主视觉不要用泛泛的机器人形象或模糊的科技背景，要用具体的物件表达文章主题，比如提示词卡片、设计画布、图片生成面板、封面草稿。题图上的中文主标题从文章标题提炼，必须清晰可读，最好 6 到 10 个汉字。构图要适合公众号封面：大标题放上面，主视觉放下面，文字左右撑满。风格：成熟的新媒体编辑部封面，干净、精致、实用，不要廉价营销海报感。避免：乱码文字、过多小字、真实品牌 logo、纯氛围壁纸、厚重的蓝紫渐变。正文其他内容都不要动。" },
                { id: "cartoon-explainer", label: "卡通解释图", instruction: "给这篇文章画一张扁平卡通风格的解释图（flat cartoon explanation illustration），插入到正文最能帮助理解的位置，让没读过文章的人扫一眼就能看懂文章的核心结构。先读懂全文，找出核心结构——分几个阶段？有什么对比？有什么递进？——再把这个结构画出来。画幅比例由内容决定，以一眼读懂为准：双行对照用 3:2 或 4:3 横版，流程递进用横长条（2.45:1 或 3:1），层级深度用竖版（3:4 或 4:5），凝聚式概念用方形 1:1。风格：像 New Yorker 杂志插图、xkcd 或高级科普读物的插画，既有趣又有思想深度；人物几何化简化（火柴人或圆头方身），线条清晰，无写实细节；配色温暖克制，最多 4 到 5 种主色，建议米白底加深色线条加 1 到 2 个强调色（橙红、墨绿、深蓝任选）；质感纯平面或轻微手绘线条感，像在白纸上手绘的概念图，不像 PPT 或 Canva 模板。构图：把核心层级、阶段或对比关系分区并列展开（从左到右、上下分层或环形排布），用箭头、台阶、流程线等通用视觉符号连接各区；每个分区只画 1 个主场景加 1 个核心物件，不堆细节；每个分区可配 1 个 2 到 6 字的中文短标签，标签必须准确、可读、无伪汉字；分区之间留呼吸空间，整体不能挤。必须避免：真人脸部（用简化几何代替）、文字过多（只用关键标签，不是 PPT）、抽象到看不懂（必须能读图理解文章）、风格不统一、饱和霓虹、廉价渐变、3D 拟真、金属玻璃光泽、儿童读物感、中国风滥用、任何水印签名 Logo 二维码、错字漏字伪中文笔画。正文其他内容都不要动。" },
              ],
            },
          ]],
        },
      },
    },
  },
};

export async function loadUIConfig(env) {
  try {
    const o = await env.FILES.get("config/ui-config.json");
    if (o) {
      const cfg = JSON.parse(await o.text());
      if (cfg && typeof cfg === "object" && typeof cfg.schema === "number" && cfg.pages && typeof cfg.pages === "object") return cfg;
    }
  } catch { /* 坏数据回退内置 */ }
  return DEFAULT_UI_CONFIG;
}

// ── 每用户稀疏覆盖 ────────────────────────────────────────────────────────────
// users/<sub>/ui-config.json 存：
//   { overrides: { "<叶子路径id>": { instruction?: "…", label?: "新名字" } },
//     hidden: ["<叶子路径id>", …] }
// 兼容旧格式（overrides 值为纯字符串 = 只覆盖 instruction）。叶子路径 id 与
// prompt-registry 的 flattenPrompts 同规则。空串一律忽略 = 回落缺省；hidden 的
// 叶子从菜单里滤掉（空掉的 submenu 由客户端渲染器跳过）。坏文件当没有。

export async function loadUserOverrides(env, scope) {
  const empty = { overrides: {}, hidden: [] };
  if (!scope || !scope.startsWith("users/")) return empty;
  try {
    const o = await env.FILES.get(`${scope}ui-config.json`);
    if (!o) return empty;
    const doc = JSON.parse(await o.text());
    if (!doc || typeof doc !== "object") return empty;
    const overrides = {};
    for (const [k, v] of Object.entries(doc.overrides && typeof doc.overrides === "object" ? doc.overrides : {})) {
      if (typeof v === "string") { if (v.trim()) overrides[k] = { instruction: v }; continue; }
      if (!v || typeof v !== "object") continue;
      const entry = {};
      if (typeof v.instruction === "string" && v.instruction.trim()) entry.instruction = v.instruction;
      if (typeof v.label === "string" && v.label.trim()) entry.label = v.label.trim();
      if (Object.keys(entry).length) overrides[k] = entry;
    }
    const hidden = Array.isArray(doc.hidden) ? [...new Set(doc.hidden.filter((h) => typeof h === "string" && h))] : [];
    return { overrides, hidden };
  } catch { return empty; }
}

export function applyUserOverrides(cfg, user) {
  const { overrides = {}, hidden = [] } = user || {};
  if (!Object.keys(overrides).length && !hidden.length) return cfg;
  const next = JSON.parse(JSON.stringify(cfg));
  const hide = new Set(hidden);
  for (const [page, interactions] of Object.entries(next.pages || {})) {
    for (const [interaction, nodes] of Object.entries(interactions || {})) {
      for (const [node, spec] of Object.entries(nodes || {})) {
        const walk = (item, idPrefix) => {
          const id = `${idPrefix}.${item.id}`;
          const ov = overrides[id];
          if (ov && typeof item.instruction === "string") {
            if (ov.instruction) item.instruction = ov.instruction;
            if (ov.label) item.label = ov.label;
          }
          if (item.children) item.children = item.children.filter((c) => !hide.has(`${id}.${c.id}`));
          for (const c of item.children || []) walk(c, id);
        };
        for (const spec2 of [spec]) {
          spec2.groups = (spec2.groups || []).map((g) =>
            g.filter((item) => !hide.has(`${page}.${interaction}.${node}.${item.id}`)));
          for (const item of spec2.groups.flat()) walk(item, `${page}.${interaction}.${node}`);
        }
      }
    }
  }
  return next;
}

/// 某个用户的最终生效配置：内置缺省 ← 全局 R2 覆盖 ← 该用户稀疏覆盖。
export async function loadUIConfigFor(env, scope) {
  const base = await loadUIConfig(env);
  return applyUserOverrides(base, await loadUserOverrides(env, scope));
}
