// test/book-shelf.test.js — 公开书架：类目八选一、R2 缓存 + 写失效、?format=search 搜索索引。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/[[path]].js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { PUBLISHER, SHELF_CACHE_KEY, CATEGORY_ORDER, touchesShelf, invalidateShelf } from "../../functions/lib/books-shelf.js";

const OWNER_TOK = "anon_owner_token_abcdefghijklmnop";
const srcKey = (slug) => `${PUBLISHER}${slug}/_src/book.json`;

const newBook = (slug, extra = {}) => JSON.stringify({
  slug, title: `${slug} 的书`, createdAt: 1700000000000, author: "王建硕", introTeaser: `${slug} 的钩子`,
  chapters: [
    { no: 1, title: "第一章 · 洗牌", brief: "用洗牌讲无序", status: "done" },
    { no: 2, title: "第二章 · 小妖", brief: "麦克斯韦的小妖", status: "planned" },
  ],
  ...extra,
});

const legacyIndexHtml = `<!doctype html><html><body>
<h1>灯塔的作用</h1><p class="sub">海上的公共基础设施</p>
<a class="introcard" href="intro.html"><b>导读</b><p>先从一盏灯说起。</p></a>
<div class="toc"><a class="row done" href="01.html"><span class="no">01</span>
<span class="t"><b>第一章 · 一盏灯</b><p>灯塔为什么是公共品</p></span></a>
<a class="row done" href="02.html"><span class="no">02</span>
<span class="t"><b>第二章 · 谁来付钱</b><p>灯塔税与港口费</p></span></a></div>
</body></html>`;

async function shelfEnv() {
  const owner = await anonScopeFromToken(OWNER_TOK);
  return fakeEnv({
    [srcKey("entropy")]: newBook("entropy", { category: "科学" }),
    [srcKey("money")]: newBook("money", { category: "钱" }),            // 不在八个词里 → 当没写
    [srcKey("secret")]: newBook("secret", { category: "故事", hidden: true, owner }),
    [srcKey("lighthouse")]: JSON.stringify({ legacy: true, slug: "lighthouse", title: "灯塔的作用", createdAt: 1600000000000, chaptersCount: 2, author: "王建硕", category: "科学" }),
    [`${PUBLISHER}lighthouse/index.html`]: legacyIndexHtml,
  });
}

// bg 收集 waitUntil 里的后台重算，测试里 `await Promise.all(bg)` 等它跑完。
function call(env, { format, token, bg } = {}) {
  const url = `https://voicedrop.cn/books/${format ? `?format=${format}` : ""}`;
  const req = new Request(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  return onRequest({ request: req, env, params: { path: [] }, waitUntil: (p) => { if (bg) bg.push(p); } });
}
const titleOf = (books, slug) => books.find((b) => b.slug === slug).title;
const cacheDoc = (env) => JSON.parse(env.FILES._store.get(SHELF_CACHE_KEY));

describe("书架类目", () => {
  it("category 只认八个词，别的当没写；导航按固定顺序只列有书的类目", async () => {
    const env = await shelfEnv();
    const { books } = await (await call(env, { format: "json" })).json();
    const cat = Object.fromEntries(books.map((b) => [b.slug, b.category]));
    expect(cat.entropy).toBe("科学");
    expect(cat.lighthouse).toBe("科学");
    expect(cat.money).toBe("");
    expect(CATEGORY_ORDER).toEqual(["商业", "投资", "AI", "科学", "人文", "身心", "生活", "故事"]);

    const html = await (await call(env)).text();
    const tabs = /<nav class="tabs">(.*?)<\/nav>/s.exec(html)[1];
    const names = [...tabs.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(names).toEqual(["全部", "科学"]);      // 故事那本是 hidden，匿名看不到 → 不列
  });
});

describe("书架缓存", () => {
  it("第一次请求同步现算并落 R2；book.json 偷偷改了但没失效 → 仍旧读缓存；删缓存 → 再同步现算", async () => {
    const env = await shelfEnv();
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(false);
    let { books } = await (await call(env, { format: "json" })).json();
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(true);
    expect(titleOf(books, "entropy")).toBe("entropy 的书");

    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("entropy 的书");

    await env.FILES.delete(SHELF_CACHE_KEY);
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("改过的书名");
  });

  it("作废 = 盖 staleAt：下一次请求先拿旧清单、后台重算；重算完再请求才是新的", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    await invalidateShelf(env);
    expect(cacheDoc(env).staleAt).toBeTruthy();
    expect(cacheDoc(env).books.length).toBeGreaterThan(0);   // 旧清单还在，没被删

    const bg = [];
    let { books } = await (await call(env, { format: "json", bg })).json();
    expect(titleOf(books, "entropy")).toBe("entropy 的书");   // 先给旧的
    expect(bg.length).toBe(1);                                // 起了一次后台重算

    await Promise.all(bg);
    expect(cacheDoc(env).staleAt).toBeUndefined();
    expect(cacheDoc(env).rebuildingAt).toBeUndefined();
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("改过的书名");
  });

  it("重算锁：一分钟内已有人在重算 → 不再起第二次；锁过期 → 照起", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const doc = cacheDoc(env);
    env.FILES._store.set(SHELF_CACHE_KEY, JSON.stringify({ ...doc, staleAt: Date.now(), rebuildingAt: Date.now() - 10 * 1000 }));
    let bg = [];
    let r = await call(env, { format: "json", bg });
    expect(r.status).toBe(200);
    expect(bg.length).toBe(0);
    expect(JSON.parse(env.FILES._store.get(SHELF_CACHE_KEY)).staleAt).toBeTruthy();  // 没人动它

    env.FILES._store.set(SHELF_CACHE_KEY, JSON.stringify({ ...doc, staleAt: Date.now(), rebuildingAt: Date.now() - 2 * 60 * 1000 }));
    bg = [];
    r = await call(env, { format: "json", bg });
    expect(bg.length).toBe(1);
    await Promise.all(bg);
    expect(cacheDoc(env).staleAt).toBeUndefined();
  });

  it("超过 TTL 的缓存同样先用后算", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const cached = cacheDoc(env);
    cached.builtAt = Date.now() - 2 * 60 * 60 * 1000;
    env.FILES._store.set(SHELF_CACHE_KEY, JSON.stringify(cached));
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    const bg = [];
    let { books } = await (await call(env, { format: "json", bg })).json();
    expect(titleOf(books, "entropy")).toBe("entropy 的书");
    await Promise.all(bg);
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("改过的书名");
  });

  it("没有 waitUntil（本地/测试）也不会挂：重算自己跑完", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await invalidateShelf(env);
    const req = new Request("https://voicedrop.cn/books/?format=json");
    const r = await onRequest({ request: req, env, params: { path: [] } });
    expect(r.status).toBe(200);
    for (let i = 0; i < 20 && cacheDoc(env).staleAt; i++) await new Promise((res) => setTimeout(res, 5));
    expect(cacheDoc(env).staleAt).toBeUndefined();
  });

  it("缓存是全量（含 hidden 书），按请求者过滤：匿名看不到 hidden，主人看得到", async () => {
    const env = await shelfEnv();
    let { books } = await (await call(env, { format: "json" })).json();
    expect(books.map((b) => b.slug)).not.toContain("secret");
    ({ books } = await (await call(env, { format: "json", token: OWNER_TOK })).json());
    const s = books.find((b) => b.slug === "secret");
    expect(s.hidden).toBe(true);
    expect(s.mine).toBe(true);
  });

  it("隐藏开关写完 book.json 顺手作废缓存", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    expect(cacheDoc(env).staleAt).toBeUndefined();
    const req = new Request("https://voicedrop.cn/books/entropy/hidden", {
      method: "POST", headers: { Authorization: "Bearer " + OWNER_TOK }, body: JSON.stringify({ hidden: true }),
    });
    // entropy 没 owner → 归发布者，OWNER_TOK 不是主人 → 403，不该动缓存
    let r = await onRequest({ request: req, env, params: { path: ["entropy", "hidden"] } });
    expect(r.status).toBe(403);
    expect(cacheDoc(env).staleAt).toBeUndefined();
    // secret 是主人的 → 200，缓存作废
    const req2 = new Request("https://voicedrop.cn/books/secret/hidden", {
      method: "POST", headers: { Authorization: "Bearer " + OWNER_TOK }, body: JSON.stringify({ hidden: false }),
    });
    r = await onRequest({ request: req2, env, params: { path: ["secret", "hidden"] } });
    expect(r.status).toBe(200);
    expect(cacheDoc(env).staleAt).toBeTruthy();
  });

  it("touchesShelf：书文件夹下任何 key 都算，别的 scope / books 根本身不算", () => {
    expect(touchesShelf(`${PUBLISHER}entropy/_src/book.json`)).toBe(true);
    expect(touchesShelf(`${PUBLISHER}entropy/cover.jpg`)).toBe(true);
    expect(touchesShelf(PUBLISHER)).toBe(false);
    expect(touchesShelf("users/anon-other/books/x/index.html")).toBe(false);
    expect(touchesShelf(`${PUBLISHER.replace(/books\/$/, "")}articles/a.json`)).toBe(false);
  });
});

describe("搜索索引 ?format=search", () => {
  it("新书从 book.json 取章节（只要 done 的），老书从 index.html 抠目录；hidden 匿名不出", async () => {
    const env = await shelfEnv();
    const r = await call(env, { format: "search" });
    expect(r.headers.get("Content-Type")).toContain("application/json");
    const { books } = await r.json();
    const by = Object.fromEntries(books.map((b) => [b.slug, b]));
    expect(by.secret).toBeUndefined();

    expect(by.entropy.intro).toBe("entropy 的钩子");
    expect(by.entropy.toc).toEqual([{ t: "第一章 · 洗牌", b: "用洗牌讲无序" }]);
    expect(by.entropy.category).toBe("科学");

    expect(by.lighthouse.sub).toBe("海上的公共基础设施");
    expect(by.lighthouse.intro).toBe("先从一盏灯说起。");
    expect(by.lighthouse.toc).toEqual([
      { t: "第一章 · 一盏灯", b: "灯塔为什么是公共品" },
      { t: "第二章 · 谁来付钱", b: "灯塔税与港口费" },
    ]);
  });

  it("主人带 token → 自己的 hidden 书也进搜索索引", async () => {
    const env = await shelfEnv();
    const { books } = await (await call(env, { format: "search", token: OWNER_TOK })).json();
    expect(books.map((b) => b.slug)).toContain("secret");
  });
});
