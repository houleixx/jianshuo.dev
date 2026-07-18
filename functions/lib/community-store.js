// functions/lib/community-store.js — 社区帖子的存储键与身份约定（单一真源）。
// 对标 article-store / style-store：shareId 怎么推导、帖子/举报存哪、合法 ID 长什么样，
// 只有这个模块知道。此前 miner 的自动分享和 Files API 的手动分享各自内联同一套
// 推导，靠 "we mirror EXACTLY" 注释人肉保持一致；校验正则也漂移出 {12} 与 {1,32}
// 两个版本（线上数据实测全部 12 位）。现在共用此处，不可能再漂。

import { hmacSign } from "./auth.js";

// shareId 固定 12 位（hmacSign b64url 输出 slice(0,12)）。
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{12}$/;
export const isShareId = (s) => SHARE_ID_RE.test(String(s || ""));

// 同一篇文章永远推导出同一个 shareId → 重复分享原地更新同一个帖子，
// firstSharedAt 得以保留。
export async function shareIdFor(articleKey, secret) {
  return (await hmacSign("community:" + articleKey, secret)).slice(0, 12);
}

export const communityKey = (shareId) => `community/${shareId}.json`;
export const reportKey = (shareId) => `community/reports/${shareId}.json`;

// 提示词分享的展示标题（单一真源）：副本带 groupPath（原作者的分组路径，今天树两级
// 封顶所以至多一段，格式上留给未来多层）→「分组｜名字」；没带 = 名字本身。
// 消费方：D1 索引 title、community/get 合成、落地页 <h1>、分享前的关键词审核。
export function promptPostTitle(leaf) {
  const label = (leaf && typeof leaf.label === "string" ? leaf.label : "").trim();
  const path = Array.isArray(leaf?.groupPath)
    ? leaf.groupPath.filter((g) => typeof g === "string" && g.trim()).map((g) => g.trim())
    : [];
  return [...path, label].filter(Boolean).join("｜");
}
