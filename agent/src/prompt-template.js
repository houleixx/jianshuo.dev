// src/prompt-template.js — 提示词系统模板（真源）。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 形状 = 和用户列表一模一样的有序树（两级封顶）。每条 action 自带 appliesTo
// （在哪个长按菜单里出现）和可选 kind（产出什么）——这两件事是分开的：
// 「插入图片·公众号题图」appliesTo=["text"]（长按文字时出现）但 kind="image"（产出是图）。
//
// id 是稳定但【无语义】的键：不编码菜单归属、不编码层级。老设计把菜单路径当主键
// （voice-editor.longpress.image.style.cartoon），导致"改这条出现在哪"= 改主键 = 断掉
// 所有已有覆盖和已铸分享码。这里彻底废掉那套。
//
// 真源 = 下面的字面量；R2 `config/prompt-template.json` 合法则整体覆盖（零部署调优，
// 照 ui-config 先例）。用户没动过的条目在他列表里是 {"ref":"sys_*"}，永远读到这里的最新版。

export const DEFAULT_PROMPT_TEMPLATE = {
  schema: 1,
  items: [
    {
      id: "sys_style", type: "group", label: "图片风格",
      children: [
        { id: "sys_cartoon", type: "action", label: "卡通", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）重画成宫崎骏动画的手绘卡通风格，构图和主体不变，正文其他内容都不要动。" },
        { id: "sys_ad", type: "action", label: "广告", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）重新设计成一则商品广告。请从专业设计师的角度，结合本篇文章的内容和受众，打造一个精致、洗练的视觉设计。整体风格要现代、极简，不使用文字，可以加一些别的代替文字的元素。请通过合理的版式构成，最大限度地突出商品的魅力。正文其他内容都不要动。" },
        { id: "sys_watercolor", type: "action", label: "水彩", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）重画成通透的水彩画风格，构图和主体不变，正文其他内容都不要动。" },
        { id: "sys_sketch", type: "action", label: "素描", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）重画成铅笔素描风格，构图和主体不变，正文其他内容都不要动。" },
        { id: "sys_oil", type: "action", label: "油画", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）重画成古典油画风格，构图和主体不变，正文其他内容都不要动。" },
        { id: "sys_film", type: "action", label: "胶片", appliesTo: ["image"], kind: "image",
          prompt: "把这张图（[[photo:{{KEY}}]]）调成胶片摄影的质感和色调，构图和主体不变，正文其他内容都不要动。" },
      ],
    },
    {
      id: "sys_rewrite", type: "group", label: "改写这段",
      children: [
        { id: "sys_concise", type: "action", label: "更简洁", appliesTo: ["text"],
          prompt: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更简洁，意思不变，正文其他行都不要动。" },
        { id: "sys_casual", type: "action", label: "更口语", appliesTo: ["text"],
          prompt: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更口语、像平时说话，意思不变，正文其他行都不要动。" },
        { id: "sys_formal", type: "action", label: "更书面", appliesTo: ["text"],
          prompt: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）改写得更书面、更正式，意思不变，正文其他行都不要动。" },
        { id: "sys_expand", type: "action", label: "扩写一点", appliesTo: ["text"],
          prompt: "把第{{LINE}}行（开头是\"{{QUOTE}}\"）扩写一点，补充细节但别啰嗦，正文其他行都不要动。" },
      ],
    },
    {
      id: "sys_insert", type: "group", label: "插入图片",
      children: [
        { id: "sys_wechat_cover", type: "action", label: "公众号题图", appliesTo: ["text"], kind: "image",
          prompt: "给这篇文章画一张微信公众号题图，放在文章最前面。画面为 2.45:1 的横幅比例。主视觉不要用泛泛的机器人形象或模糊的科技背景，要用具体的物件表达文章主题，比如提示词卡片、设计画布、图片生成面板、封面草稿。题图上的中文主标题从文章标题提炼，必须清晰可读，最好 6 到 10 个汉字。构图要适合公众号封面：大标题放上面，主视觉放下面，文字左右撑满。风格：成熟的新媒体编辑部封面，干净、精致、实用，不要廉价营销海报感。避免：乱码文字、过多小字、真实品牌 logo、纯氛围壁纸、厚重的蓝紫渐变。正文其他内容都不要动。" },
        { id: "sys_cartoon_explainer", type: "action", label: "卡通解释图", appliesTo: ["text"], kind: "image",
          prompt: "给这篇文章画一张扁平卡通风格的解释图（flat cartoon explanation illustration），插入到正文最能帮助理解的位置，让没读过文章的人扫一眼就能看懂文章的核心结构。先读懂全文，找出核心结构——分几个阶段？有什么对比？有什么递进？——再把这个结构画出来。画幅比例由内容决定，以一眼读懂为准：双行对照用 3:2 或 4:3 横版，流程递进用横长条（2.45:1 或 3:1），层级深度用竖版（3:4 或 4:5），凝聚式概念用方形 1:1。风格：像 New Yorker 杂志插图、xkcd 或高级科普读物的插画，既有趣又有思想深度；人物几何化简化（火柴人或圆头方身），线条清晰，无写实细节；配色温暖克制，最多 4 到 5 种主色，建议米白底加深色线条加 1 到 2 个强调色（橙红、墨绿、深蓝任选）；质感纯平面或轻微手绘线条感，像在白纸上手绘的概念图，不像 PPT 或 Canva 模板。构图：把核心层级、阶段或对比关系分区并列展开（从左到右、上下分层或环形排布），用箭头、台阶、流程线等通用视觉符号连接各区；每个分区只画 1 个主场景加 1 个核心物件，不堆细节；每个分区可配 1 个 2 到 6 字的中文短标签，标签必须准确、可读、无伪汉字；分区之间留呼吸空间，整体不能挤。必须避免：真人脸部（用简化几何代替）、文字过多（只用关键标签，不是 PPT）、抽象到看不懂（必须能读图理解文章）、风格不统一、饱和霓虹、廉价渐变、3D 拟真、金属玻璃光泽、儿童读物感、中国风滥用、任何水印签名 Logo 二维码、错字漏字伪中文笔画。正文其他内容都不要动。" },
      ],
    },
  ],
};

/// 模板形状最小校验：{schema, items:[…]}。坏数据一律回退内置（配置错不能打挂线上）。
function looksLikeTemplate(o) {
  return !!o && typeof o === "object" && typeof o.schema === "number" && Array.isArray(o.items);
}

export async function loadPromptTemplate(env) {
  try {
    const obj = await env.FILES.get("config/prompt-template.json");
    if (obj) {
      const parsed = JSON.parse(await obj.text());
      if (looksLikeTemplate(parsed)) return parsed;
    }
  } catch (e) {
    console.error("[prompt-template] bad config/prompt-template.json:", e && e.message);
  }
  return DEFAULT_PROMPT_TEMPLATE;
}

/// 打平成 Map<id, node>，含 group 节点（group 的 label 也要能被 ref 解析到）。
export function templateIndex(tpl) {
  const map = new Map();
  for (const item of tpl.items || []) {
    map.set(item.id, item);
    for (const child of item.children || []) map.set(child.id, child);
  }
  return map;
}
