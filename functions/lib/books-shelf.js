// lib/books-shelf.js — 公开书架的常量与缓存钥匙，books 路由和 files API 共用。
//
// 书架数据（每本书的 title/author/category/hidden/owner/章节目录…）以各书的
// `_src/book.json` 为真源，但每刷一次书架就把两百多本逐个读一遍不划算，且搜索
// 还要老书的目录页（41 本没有 book.json 章节清单、得抠 index.html）。所以 books
// 路由把整理好的全量清单缓存成 R2 里一份 JSON（SHELF_CACHE_KEY），带 builtAt。
//
// 失效是 stale-while-revalidate，不是删：全量重算实测 15 秒（两百多次 R2 读 + 41 本
// 老书抠目录页），而每发一章都会失效一次，删掉的话发书后第一个访客要干等 15 秒。
// 所以任何一次写进 books/<slug>/ 的上传（files API upload、setHidden、build.mjs 发布、
// 类目回填）只在缓存上盖一个 staleAt；下一次请求先用旧清单立刻响应，同时 waitUntil
// 后台重算写回，再下一次就是新的。1 小时 TTL 同样走这条路（作者改了 profile 名而书
// 没动时最迟一小时收敛）。只有缓存根本不存在时才同步现算。
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

/// 标记缓存过期（保留旧清单供下一次请求先用）。绝不 throw——失效失败最多让书架
/// 多陈旧一小时，不能把上传打挂。缓存还不存在就什么都不做。
export async function invalidateShelf(env) {
  try {
    const o = await env.FILES.get(SHELF_CACHE_KEY);
    if (!o) return;
    const c = JSON.parse(await o.text());
    if (!c || !Array.isArray(c.books)) return;
    if (c.staleAt) return;                        // 已经标过，别为每一章上传都重写一遍
    await env.FILES.put(SHELF_CACHE_KEY, JSON.stringify({ ...c, staleAt: Date.now() }),
      { httpMetadata: { contentType: 'application/json' } });
  } catch {}
}

/// 缓存文档 → 状态：'fresh' 直接用；'stale' 先用旧的、后台重算；null 没有/坏了。
export function shelfCacheState(c) {
  if (!c || !Array.isArray(c.books)) return null;
  const age = Date.now() - (Number(c.builtAt) || 0);
  return (c.staleAt || age >= SHELF_CACHE_TTL_MS) ? 'stale' : 'fresh';
}
