// Run ONE voice-edit instruction end-to-end: load the article, build the prompt
// (transcript + images + current article + instruction), drive the agent loop,
// read the doc back, and return a client-ready result. Lifted out of the
// ArticleEditor DO so it unit-tests and the DO stays thin. All I/O is via env /
// the injected callClaude.

import { runAgentLoop } from "./loop.js";
import { resolveArticles, withTopLevelArticles } from "../../functions/lib/article-store.js";

const TERMINAL = ["write_article", "write_style", "publish_wechat", "share_to_community"];

export async function runEditTurn({ env, scope, articleKey, token, origin, editId, instruction, images = [], system, history = [], callClaude }) {
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

  const stableText = [
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
  varLines.push("这次的语音指令：", instruction);

  const userContent = [
    { type: "text", text: stableText },
    ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data } })),
    { type: "text", text: varLines.join("\n") },
  ];

  const ctx = { env, scope, articleKey, token, origin, editId };
  const result = await runAgentLoop({ callClaude, ctx, system, userContent, history });

  const after = await env.FILES.get(articleKey);
  const finalDoc = after ? JSON.parse(await after.text()) : doc;

  const summary = (result.finalText || "").trim();
  const didAct = (result.calledTools || []).some((n) => TERMINAL.includes(n));
  const reply = summary || (result.hadError ? "操作没完成" : (didAct ? "改好了" : ""));

  return { ok: !result.hadError, reply, article: withTopLevelArticles(finalDoc), hadError: !!result.hadError };
}
