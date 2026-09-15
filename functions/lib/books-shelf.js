// lib/books-shelf.js — 公开书架的常量与缓存钥匙，books 路由和 files API 共用。
//
// 书架数据（每本书的 title/author/category/hidden/owner/章节目录…）以各书的
// `_src/book.json` 为真源，但每刷一次书架就把两百多本逐个读一遍不划算，且搜索
// 还要老书的目录页（41 本没有 book.json 章节清单、得抠 index.html）。所以 books
// 路由把整理好的全量清单缓存成 R2 里一份 JSON（SHELF_CACHE_KEY），带 builtAt；
// 任何一次写进 books/<slug>/ 的上传（files API upload、setHidden、build.mjs 发布、
// 类目回填）都把它删掉，下一次请求现算再写回。写路径失效 + 1 小时兜底 TTL——
// 作者改了 profile 名而书没动时，最迟一小时收敛。
//
// 钥匙放在发布者 scope 下的 books-cache/ 而不是 books/ 里：books/ 是公开只读路由
// 的根，缓存里带 hidden 书和 owner，不能被 /voicedrop/books/_shelf.json 直接拿走。

export const PUBLISHER_SCOPE = 'users/anon-ae209ac53499d51d513425503bd134b0/';
export const PUBLISHER = PUBLISHER_SCOPE + 'books/';
export const SHELF_CACHE_KEY = PUBLISHER_SCOPE + 'books-cache/shelf.json';
export const SHELF_CACHE_TTL_MS = 60 * 60 * 1000;

// 类目（2026-09-15 定的八个词；2026-08-17 的六个 + 科学 + 生活）：书架导航顺序 +
// 每本书的标签。book.json 的 category 只认这八个，别的当没写。
export const CATEGORY_ORDER = ['商业', '投资', 'AI', '科学', '人文', '身心', '生活', '故事'];
export const normalizeCategory = (c) => {
  const s = String(c || '').trim();
  return CATEGORY_ORDER.includes(s) ? s : '';
};

/// 这个 key 的写入会不会影响书架？→ 是书文件夹下的任何东西（含 _src/ 与 cover.jpg）。
export const touchesShelf = (key) => typeof key === 'string' && key.startsWith(PUBLISHER) && key.length > PUBLISHER.length;

/// 删缓存。绝不 throw——失效失败最多让书架多陈旧一小时，不能把上传打挂。
export async function invalidateShelf(env) {
  try { await env.FILES.delete(SHELF_CACHE_KEY); } catch {}
}
