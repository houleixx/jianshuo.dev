// src/prompt-community.js — 提示词社区帖：分享即发帖，帖码同生同死。
// spec: voicedrop repo docs/superpowers/specs/2026-07-15-prompt-community-posts-design.md
//
// 帖 = community/<shareId>.json 的 kind:"prompt" 变体，内容零复制——正文实时读
// shares/<码>（写穿副本，作者保存时 refreshPromptShare 已同步）。shareId 从【码】
// HMAC 派生（不从 itemId）：码一辈子不变（含 fork re-key），同码同帖复活、fork 后
// 帖不断，全部自动成立，索引里不用存任何新绑定。
import { shareIdFor, communityKey } from "../../functions/lib/community-store.js";
import { readProfileName } from "../../functions/lib/style-store.js";

export const promptShareId = (code, secret) => shareIdFor(`promptshare:${code}`, secret);

// 卡片预览口径对齐 Pages 的 cardExtras：纯文本前 60 字。
const previewOf = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);

/// 发帖（开分享/复活时调用）。失败吞掉返回 null——发帖是铸码的附属动作，
/// 绝不能让它拖垮铸码本身；漂移由 reconcileIndex 收敛。
export async function publishPromptPost(env, scope, code, leaf) {
  try {
    const shareId = await promptShareId(code, env.SESSION_SECRET);
    const key = communityKey(shareId);
    let firstSharedAt = Date.now();
    const existing = await env.FILES.get(key);
    if (existing) {
      try { firstSharedAt = JSON.parse(await existing.text()).firstSharedAt || firstSharedAt; } catch {}
    }
    let author = "";
    try { author = await readProfileName(env, scope); } catch {}
    const post = { schema: 2, shareId, owner: scope, kind: "prompt", promptCode: code,
                   author, firstSharedAt };
    await env.FILES.put(key, JSON.stringify(post), { httpMetadata: { contentType: "application/json" } });
    await indexUpsertPrompt(env, post, leaf);
    return shareId;
  } catch (e) { console.error("[prompt-community] publish failed:", e && e.message); return null; }
}

/// 撤帖（关分享时调用）。best-effort、幂等。
export async function retractPromptPost(env, code) {
  try {
    const shareId = await promptShareId(code, env.SESSION_SECRET);
    await env.FILES.delete(communityKey(shareId));
    if (env.RECO_DB) {
      try {
        await env.RECO_DB.prepare("DELETE FROM community_posts WHERE share_id=?").bind(shareId).run();
      } catch (e) { console.log("[prompt-community] index delete failed", String(e?.message || e)); }
    }
  } catch (e) { console.error("[prompt-community] retract failed:", e && e.message); }
}

// D1 展示索引行（与 Pages indexUpsert 的 prompt 语义一致：title=label、
// preview=正文前60字、无图）。写失败吞掉。
async function indexUpsertPrompt(env, post, leaf) {
  if (!env.RECO_DB) return;
  try {
    await env.RECO_DB.prepare(
      `INSERT INTO community_posts (share_id, owner, article_key, author, title, preview,
         cover_photo_key, has_photo, article_count, first_shared_at, updated_at, reply_to, hidden, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(share_id) DO UPDATE SET
         owner=excluded.owner, author=excluded.author, title=excluded.title,
         preview=excluded.preview, updated_at=excluded.updated_at, hidden=excluded.hidden,
         kind=excluded.kind`,
    ).bind(post.shareId, post.owner, null, post.author || "", leaf.label || "",
           previewOf(leaf.instruction) || null, null, 0, 1,
           post.firstSharedAt, Date.now(), null, 0, "prompt").run();
  } catch (e) { console.log("[prompt-community] index upsert failed", String(e?.message || e)); }
}
