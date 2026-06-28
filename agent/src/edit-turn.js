// Run ONE voice-edit instruction end-to-end: load the article, build the prompt
// (transcript + images + current article + instruction), drive the agent loop,
// read the doc back, and return a client-ready result. Lifted out of the
// ArticleEditor DO so it unit-tests and the DO stays thin. All I/O is via env /
// the injected callClaude.

import { runAgentLoop } from "./loop.js";
import { resolveArticles, withTopLevelArticles } from "../../functions/lib/article-store.js";
import { locatorTable } from "./linenum.js";

const TERMINAL = ["edit_current_article", "write_article", "write_style", "publish_wechat", "share_to_community"];

export async function runEditTurn({ env, scope, articleKey, token, origin, editId, instruction, images = [], articleIndex = 0, system, history = [], callClaude }) {
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

  const varLines = [
    "当前文章（你正在编辑这一篇）：",
    JSON.stringify({ articles: articles.map((a) => ({ title: a.title, body: a.body })) }, null, 2),
    "",
  ];
  if (images.length > 0) {
    varLines.push(
      "本次上传的新照片（已在消息里附上缩略图，按顺序对应上方图片）。把每一张插到正文最合适的位置，用它自己的 key 作标记，原样写进正文：",
      ...images.map((img) => `  [[photo:${img.key}]]`),
      "",
      "⚠️ 必须把以上每一张照片都插入文章正文里合适的段落，使用对应的 [[photo:<key>]] 标记。一张都不能漏。",
      "",
    );
  }
  // 行号对照：number the article the user is LOOKING AT exactly the way the iOS app
  // does, and hand the model that table so it RESOLVES「第N行 / 图M」by reading the
  // number — never by counting lines itself (where the号 used to drift from what the
  // user saw). The full body above stays clean for faithful rewriting.
  const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;
  const target = articles[idx];
  if (target) {
    const table = locatorTable(target.body || "");
    varLines.push(
      "",
      articles.length > 1
        ? `行号对照（用户此刻在看第 ${idx + 1} 篇「${target.title || "无题"}」，他说的「第N行 / 图M」都指这一篇。这就是他屏幕上看到的行号，严格按它定位，别自己数行）：`
        : "行号对照（这就是用户按住说话时屏幕上看到的行号，他说的「第N行 / 图M」严格按它定位，别自己数行）：",
      table || "（正文为空）",
      "定位用完即可——改完正文里不要写行号 / 图号，[[photo:…]] 标记原样保留。",
    );
  }
  varLines.push("", "这次的语音指令：", instruction);

  const userContent = [
    ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data } })),
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
  // user is looking at (the one the 行号对照 above numbered).
  const ctx = { env, scope, articleKey, token, origin, editId, articleIndex: idx };
  const result = await runAgentLoop({ callClaude, ctx, system: systemBlocks, userContent, history });

  const after = await env.FILES.get(articleKey);
  const finalDoc = after ? JSON.parse(await after.text()) : doc;

  const summary = (result.finalText || "").trim();
  const didAct = (result.calledTools || []).some((n) => TERMINAL.includes(n));
  const reply = summary || (result.hadError ? "操作没完成" : (didAct ? "改好了" : ""));

  return { ok: !result.hadError, reply, article: withTopLevelArticles(finalDoc), hadError: !!result.hadError };
}
