// Run ONE voice-edit instruction end-to-end: load the article, build the prompt
// (transcript + images + current article + instruction), drive the agent loop,
// read the doc back, and return a client-ready result. Lifted out of the
// ArticleEditor DO so it unit-tests and the DO stays thin. All I/O is via env /
// the injected callClaude.

import { runAgentLoop } from "./loop.js";
import { TITLE_FALLBACK, resolveArticles, withTopLevelArticles } from "../../functions/lib/article-store.js";
import { inlineNumberedBody, numberBodyRows } from "./linenum.js";
import { resolveSharedPromptBlock } from "./prompt-share.js";

const TERMINAL = ["edit_current_article", "write_article", "write_style", "publish_wechat", "share_to_community", "edit_photo", "new_photo"];

// 锚点协议 —— 校验 + 漂移自愈（spec §4.1，docs/superpowers/specs/2026-07-16-anchor-protocol-design.md）。
// 全链路可选、best-effort：anchor 缺失/形状非法/校验失败一律返回 null（宁缺勿错），
// 从不 4xx、从不阻断编辑——调用方不注入即可，现状照旧。
//
// rows 必须来自 linenum.js 的 numberBodyRows（与喂给模型的 inlineNumberedBody 同一份
// 调用、同口径）：图文共用一个连续 1-based 计数器，「第 N 行」与模型在 edit_current_article
// 工具里认的行号严格一致，否则用户长按第 2 张图，模型会改到别的地方。
export function resolveAnchorLine(anchor, { rows, photoKeys }) {
  if (!anchor || typeof anchor !== "object") return null;
  if (anchor.type === "image") {
    const key = typeof anchor.key === "string" ? anchor.key : "";
    if (!key || !photoKeys.includes(key)) return null;
    return `用户长按的图片：[[photo:${key}]]（指令里说的「这张图/这张照片」就是它）`;
  }
  if (anchor.type === "line") {
    // anchor.text 防御性上限 2000 UTF-16 units（spec §3）；下面的行比对两侧都按
    // 截断后前缀比——超过 2000 的段落理论上可能因前缀相同而误判「唯一匹配」，接受
    // （真实正文段落远短于此，且误判上限也只是把 anchor 指到同前缀的另一行）。
    const text = String(anchor.text || "").slice(0, 2000);
    if (!text) return null;
    let n = Number.isInteger(anchor.line) ? anchor.line : -1;
    const row = rows.find((r) => r.n === n);
    if (!(row && row.kind === "text" && row.text.slice(0, 2000) === text)) {
      // 行号对不上（正文在长按与送达之间被并发编辑动过）：按整行原文在正文里找
      // 唯一精确匹配，找到即修正行号（自愈）；找不到或多处匹配 → 丢弃，宁缺勿错。
      const hits = rows.filter((r) => r.kind === "text" && r.text.slice(0, 2000) === text).map((r) => r.n);
      if (hits.length !== 1) { console.log("[anchor] line drift unresolved, dropped"); return null; }
      n = hits[0];
    }
    return `用户长按的是第 ${n} 行（"${text}"）（指令里说的「这段/这行」就是它）`;
  }
  return null;
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  return btoa(bin);
}

// 给模型看的插图统一 320 最大边（Cloudflare 边缘缩图）：新 app 只传 key（客户端
// 不再自己压缩略图），这里按 key 现拉；老 app 仍带 data（320 方形拉伸的历史格式）
// → 原样用。边缘转换失败 → 回退 R2 原图（1080，喂得起只是贵一点），再不行就跳过
// 该图——正文里的 [[photo:<key>]] 标记照插，模型只是看不见画面。
async function imageBlocks(images, { env, scope, origin }) {
  const out = [];
  for (const img of images) {
    let data = img.data, mediaType = img.mediaType || "image/jpeg";
    if (!data && img.key) {
      try {
        const r = await fetch(`${origin}/cdn-cgi/image/width=320,quality=70/files/api/photo/${encodeURI(scope + img.key)}`);
        if (r.ok && (r.headers.get("content-type") || "").startsWith("image/")) {
          data = bufToB64(await r.arrayBuffer());
          mediaType = r.headers.get("content-type") || "image/jpeg";
        }
      } catch {}
      if (!data) {
        try {
          const obj = await env.FILES.get(scope + img.key);
          if (obj) data = bufToB64(await obj.arrayBuffer());
        } catch {}
      }
    }
    if (data) out.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  return out;
}

export async function runEditTurn({ env, scope, articleKey, token, origin, editId, instruction, images = [], articleIndex = 0, anchor = null, system, history = [], callClaude }) {
  const obj = await env.FILES.get(articleKey);
  if (!obj) return { ok: false, reply: "", article: null, hadError: true };
  const doc = JSON.parse(await obj.text());
  // Exactly-once belt-and-suspenders: if this article already carries this
  // instruction's id, its effect already landed (a prior run wrote + stamped it,
  // then the DO/queue lost track) — return the current doc without re-running the
  // model. This makes runEditTurn idempotent ON ITS OWN, independent of the queue's
  // loadDoc skip (which is best-effort and can be bypassed on a transient read
  // failure). Closes the only residual exactly-once window from the A1 review.
  if (editId && doc.lastEditId === editId) {
    return { ok: true, reply: "", article: withTopLevelArticles(doc), hadError: false };
  }
  const articles = resolveArticles(doc);

  // Transcript = the stable fact base. It's identical across every edit of this
  // recording, so it rides in `system` (a cache prefix that sits BEFORE messages)
  // rather than in the per-turn user message — that's what lets prompt caching
  // hit it turn after turn (the current-article + instruction below still vary
  // and stay uncached). See systemBlocks below.
  const transcriptText = [
    "原始口述转写（事实来源，只能用这里出现的事实，不可编造）：",
    doc.transcript || "（无）",
  ].join("\n");

  // The article the user is editing is shown with an INLINE 第N行 / 图M number on
  // every row — that one numbered copy is BOTH the body (full text, for faithful
  // rewriting) AND the locator the user/model share. No second clean copy and no
  // separate 行号对照 table (that used to put the body in the prompt twice). The
  // numbers are prompt-only: they never enter the saved body — applyArticleEdits
  // resolves 第N行 back onto the clean rows, and the model is told not to echo them.
  const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;
  const target = articles[idx];

  const varLines = [];
  if (articles.length <= 1) {
    varLines.push(
      "当前文章（你正在编辑这一篇）。正文每行开头的「第N行 / 图M」就是用户此刻在屏幕上看到的号——他说「第N行 / 图M」严格按这个号定位，别自己数行。这些号只用来定位、不属于正文，改完别写进输出：",
      `标题：${target?.title || TITLE_FALLBACK}`,
      inlineNumberedBody(target?.body || "") || "（正文为空）",
      "",
    );
  } else {
    varLines.push(
      `共 ${articles.length} 篇，你正在编辑第 ${idx + 1} 篇。下面这篇带「第N行 / 图M」号，用户说的「第N行 / 图M」都指它——严格按号定位、别数行；号只用来定位、不属于正文，改完别写进输出：`,
      `【第 ${idx + 1} 篇 · 正在编辑】标题：${target?.title || TITLE_FALLBACK}`,
      inlineNumberedBody(target?.body || "") || "（正文为空）",
      "",
      "其余文章（仅供合并 / 参考，不用按行号定位）：",
      JSON.stringify({ articles: articles.map((a, i) => (i === idx ? { title: a.title, body: "（见上方带号正文）" } : { title: a.title, body: a.body })) }, null, 2),
      "",
    );
  }
  if (images.length > 0) {
    varLines.push(
      "本次上传的新照片（已在消息里附上缩略图，按顺序对应上方图片）。把每一张插到正文最合适的位置，用它自己的 key 作标记，原样写进正文：",
      ...images.map((img) => `  [[photo:${img.key}]]`),
      "",
      "⚠️ 必须把以上每一张照片都插入文章正文里合适的段落，使用对应的 [[photo:<key>]] 标记。一张都不能漏。",
      "",
    );
  }
  // 锚点（长按图片/文字菜单动作随手势带上的结构化定位）：校验 + 漂移自愈后，紧挨
  // 指令之前注入一条独立上下文行。rows 用 target（本次编辑这一篇）的 body 算，与
  // 上面 inlineNumberedBody 给模型看的号同一份 numberBodyRows 调用、同口径。
  // photoKeys 做两代标记格式归一：老格式正文的标记是 [[photo:5]]（裸数字 token，
  // 1-based 指向 doc.photos 数组），而 iOS 的 ArticleBody.resolvePhotoKey 在长按时
  // 已把数字解析成完整相对 key 放进 anchor.key —— 不归一的话老文章上 includes()
  // 恒 false，anchor 会被静默丢弃。数字 token → doc.photos[n-1]（与 iOS
  // resolvePhotoKey / functions/voicedrop/[token].js 的 photoRefsInBodies 同口径，
  // 越界丢弃）；非数字 token（新格式）本身就是相对 key，原样保留。
  const anchorRows = numberBodyRows(target?.body || "");
  const legacyPhotos = Array.isArray(doc.photos) ? doc.photos : [];
  const photoKeys = anchorRows
    .filter((r) => r.kind === "photo")
    .map((r) => (/^\d+$/.test(r.token) ? legacyPhotos[Number(r.token) - 1] : r.token))
    .filter(Boolean);
  const anchorLine = resolveAnchorLine(anchor, { rows: anchorRows, photoKeys });
  if (anchorLine) varLines.push("", anchorLine);
  varLines.push("", "这次的语音指令：", instruction);

  // 指令里报了 7 位分享码 → 追加对应的共享指令块（一次性参考；查无则软备注）。
  const shared = await resolveSharedPromptBlock(env, instruction);
  if (shared) varLines.push("", shared.block);

  const userContent = [
    ...(await imageBlocks(images, { env, scope, origin })),
    { type: "text", text: varLines.join("\n") },
  ];

  // Two cache breakpoints, both ephemeral:
  //   1. the static instructions (`system`) — byte-identical for every recording
  //      and user, so this segment is a shared cache prefix.
  //   2. + the transcript — identical across THIS recording's edits.
  // Everything after (history + current article + instruction) is volatile and
  // stays out of the cache.
  const systemBlocks = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
    { type: "text", text: transcriptText, cache_control: { type: "ephemeral" } },
  ];

  // articleIndex rides in ctx so edit_current_article patches the SAME article the
  // user is looking at (the inline-numbered article shown above).
  // sharedMagic：口播分享码命中时随 ctx 下行，edit_photo/new_photo 出图会把它写进
  // 图片 XMP（paint:Magic）——图走到哪，同款指令的兑换码跟到哪。instruction 原文
  // 也下行：出图时若无口播码，拿它反查自己的活跃分享（长按菜单场景，findOwnShareMagic）
  const ctx = { env, scope, articleKey, token, origin, editId, articleIndex: idx, sharedMagic: shared?.magic || null, instruction };
  const result = await runAgentLoop({ callClaude, ctx, system: systemBlocks, userContent, history });

  const after = await env.FILES.get(articleKey);
  const finalDoc = after ? JSON.parse(await after.text()) : doc;

  const summary = (result.finalText || "").trim();
  const didAct = (result.calledTools || []).some((n) => TERMINAL.includes(n));
  const reply = summary || (result.hadError ? "操作没完成" : (didAct ? "改好了" : ""));

  return { ok: !result.hadError, reply, article: withTopLevelArticles(finalDoc), hadError: !!result.hadError, toolRuns: result.toolRuns || [] };
}
