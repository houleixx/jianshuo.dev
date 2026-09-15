#!/usr/bin/env node
// wjs-voicedrop-writing-book · 组装 + 发布一本书到 R2 的 books/ 文件夹，
// 外网经 jianshuo.dev/voicedrop/books/<slug>/ 直达（免 token）。
//
// 发布位置：R2 的 books/<slug>/ 文件夹（本账号 scope 下）。
// 外网访问：https://jianshuo.dev/voicedrop/books/<slug>/index.html
//   —— /voicedrop/books/<key> 是专门的公开只读路由（免 token，no-store 不缓存，
//      按真实扩展名回 Content-Type）。写入走 files API：PUT /files/api/upload/books/<key>。
//      （该路由只读：直接 PUT/POST /voicedrop/books 会 405。）
//
// 用法：
//   node build.mjs index   <workdir>          # 渲染并发布 封面/目录页  → books/<slug>/index.html
//   node build.mjs intro   <workdir>          # 渲染并发布 导读页        → books/<slug>/intro.html
//   node build.mjs chapter <workdir> <NN>     # 渲染并发布 第 NN 章       → books/<slug>/NN.html
//   node build.mjs done    <workdir> <NN>     # 【过审即发】标 done + 落盘 book.json + 发该章 + 刷新目录（一步到位）
//   node build.mjs status  <workdir>          # 【断点续跑】列出每章 done/待发/待写 + 导读是否落盘
//   node build.mjs asset   <workdir> <本地图片> [目标名]  # 上传插图/封面到 books/<slug>/（图片按扩展名回类型）
//   （封面：把图存成 <workdir>/cover.jpg 并 asset 上传为 cover.jpg —— 只作为文件放在书目录里供别的工具取用，不嵌进正文页）
//   node build.mjs pull    <workdir> <slug>   # 【修书起手式】从线上 _src 源稿镜像重建工作目录
//   node build.mjs all     <workdir>          # index+intro+全部 done 的章节，最后打印公开 URL
// 约定：
//   <workdir>/book.json         —— 书的清单（见 SKILL.md 的「book.json 结构」）
//     其中 type=explainary|childrens|novel 决定通用文案（页脚 tagline / 目录副标注 meta）的中性缺省；
//     书自己写了 meta/tagline 就用书的，没写才按 type 兜底。三种类型页面骨架完全一致。
//   <workdir>/intro.html        —— 导读正文的 HTML 片段（可选）
//   <workdir>/chapters/NN.html  —— 第 NN 章正文的 HTML 片段（放进 <article> 的内容）
// 认证复用 wjs-voicedrop 的 token（~/.config/voicedrop/credentials）。Node ≥ 20。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkChapterSource } from "./validate.mjs";

const API = "https://jianshuo.dev/files/api";
const SITE = "https://jianshuo.dev";

function token() {
  const p = join(homedir(), ".config/voicedrop/credentials");
  try { return JSON.parse(readFileSync(p, "utf8")).token; }
  catch { console.error("找不到 token：先跑 wjs-voicedrop 的 6+4 登录"); process.exit(2); }
}
const TOKEN = token();

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");

// 书的类型（explainary 科普 / childrens 绘本 / novel 小说）——决定通用文案的中性缺省。
// book.json 里写了 meta/tagline 就用书自己的；没写才按类型兜底。
const bookType = b => (b && b.type) || "explainary";
const DEFAULTS = {
  explainary: { meta: "面向理工背景的好奇者 · 一个词/一句话长成一本书", tagline: "面向对世界有好奇心的人 · 费曼式写法 · 由多个 AI 代理撰写与互相审校" },
  childrens:  { meta: "一本图画书 · 亲子共读",                          tagline: "图画故事 · 由 AI 代理撰写与互相审校" },
  novel:      { meta: "一部虚构作品",                                   tagline: "由 AI 代理撰写与互相审校" },
};
const defMeta    = b => (DEFAULTS[bookType(b)] || DEFAULTS.explainary).meta;
const defTagline = b => (DEFAULTS[bookType(b)] || DEFAULTS.explainary).tagline;

// 页面文件名 & 站内路径
const fileName = { index: "index.html", intro: "intro.html" };
const chFile = no => `${pad(no)}.html`;
// 同一本书的所有页都在 books/<slug>/ 同级，内链用**相对文件名**（如 href="01.html"）——
// 两个域名（jianshuo.dev / voicedrop.cn）都零重定向；书架用 ../ 回到 /voicedrop/books/。
const linkPath = (slug, file) => file;                                        // 相对内链，slug 不用
const shelfPath = "../";                                                       // 回书架
const publicUrl = (slug, file) => `${SITE}/voicedrop/books/${slug}/${file}`;  // 完整外网 URL（仅打印用）

async function upload(slug, file, html, ct = "text/html; charset=utf-8") {
  const key = `books/${slug}/${file}`;                                        // R2: books/<slug>/<file>
  const r = await fetch(`${API}/upload/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": ct },
    body: html,
  });
  const t = await r.text();
  if (!r.ok) { console.error(`上传失败 ${key}: ${r.status} ${t}`); process.exit(1); }
  console.log(`ok  ${key}  →  ${publicUrl(slug, file)}`);
}

// ---------- _src 源稿镜像：让任何一次新 session 都能重建工作目录（修书模式用）----------
// 每次发布顺手把「源」也传上去：book.json + 各章正文片段 + 导读片段，
// 放在 books/<slug>/_src/ 子目录（书架统计只看顶层文件，_src 不会被当成章节）。
// 拉回：build.mjs pull <workdir> <slug>。
const srcName = f => `_src/${f}`;

// hidden 的真源在**线上**那份 `_src/book.json`：书页 ⋯ 菜单的「隐藏本书」只改线上
// （functions/voicedrop/books 的 setHidden），工作目录这份是写书那会儿生成的、根本
// 不知道后来有人藏过它。所以每次 sync 前先把线上的 hidden 读回来盖到本地，再整份 PUT
// ——不这么做的话，任何一次发布（换封面 / 刷目录 / 重发单章）都会把隐藏抹平：
// 2026-09-06《装睡的人》就是隐藏当晚被「上封面」那一步顶回书架的。
// 顺手回写工作目录，让本地那份不再继续漂着。
//
// category（2026-09-15 起）同一条路：存量书的类目是在线上批量回填的，工作目录那份
// 根本没这个字段；本地**没写**就从线上接过来，本地**写了**以本地为准（修书指令
// 「把这本归到投资」改的正是工作目录这份，得让它能发出去）。
async function mergeLiveFields(b) {
  let live;
  try {
    const r = await fetch(`${publicUrl(b.slug, srcName("book.json"))}?_=${Date.now()}`);
    if (!r.ok) return;                        // 首发：线上还没有 → 用本地的（绘本缺省 hidden 照样生效）
    live = await r.json();
  } catch { return; }                         // 读不到线上不卡发布：宁可漏一次也不能让发书失败
  if (!live || !live.slug) return;            // 不像 book.json 就当没读到
  const changed = [];
  const want = live.hidden === true;
  if (want !== (b.hidden === true)) {
    if (want) b.hidden = true; else delete b.hidden;
    changed.push(`hidden ← 线上（${want}）`);
  }
  if (!b.category && typeof live.category === "string" && live.category) {
    b.category = live.category;
    changed.push(`category ← 线上（${live.category}）`);
  }
  if (!changed.length) return;
  try { writeFileSync(join(workdir, "book.json"), JSON.stringify(b, null, 2) + "\n"); } catch {}
  for (const c of changed) console.log(`ok  ${c}`);
}

async function syncBookJson(b) {
  await mergeLiveFields(b);
  await upload(b.slug, srcName("book.json"), JSON.stringify(b, null, 2) + "\n", "application/json");
}

// ---------- 淡雅样式：暖米纸底 + 宋体正文 + 单一强调色 ----------
const CSS = book => `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --paper:#f7f2e7; --paper-deep:#efe7d4; --panel:#fcf9f1;
  --ink:#33302a; --ink-soft:#7a7264; --line:rgba(51,48,42,.14);
  --accent:${book.dark || "#a6553a"}; --tint:${book.tint || "#f0e6d4"};
  --serif:"Noto Serif SC","Songti SC","Source Han Serif SC",serif;
  --sans:"Nunito","PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
}
html{scroll-behavior:smooth}
body{background:radial-gradient(ellipse 120% 70% at 50% -8%,#fdf7ec,var(--paper));
  color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;
  line-height:1.85;min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:38px 22px 96px}
a{color:inherit;text-decoration:none}
.top{display:flex;justify-content:space-between;align-items:center;font-size:14px;
  color:var(--ink-soft);margin-bottom:34px}
.top a:hover{color:var(--accent)}
.crumb{display:flex;gap:8px;align-items:center}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);opacity:.8}
h1{font-family:var(--serif);font-weight:600;font-size:33px;line-height:1.35;letter-spacing:.3px}
.sub{color:var(--ink-soft);font-size:16px;margin-top:12px}
.meta{color:var(--ink-soft);font-size:13px;margin-top:18px;letter-spacing:.2px}
.introcard{display:block;margin:30px 0 12px;padding:20px 22px;border-radius:16px;
  background:var(--panel);border:1px solid var(--line)}
.introcard b{font-family:var(--serif);font-size:17px}
.introcard p{color:var(--ink-soft);font-size:14.5px;margin-top:6px}
.toc{margin-top:26px;display:flex;flex-direction:column;gap:2px}
.toc h3{font-family:var(--sans);font-size:12px;letter-spacing:2px;text-transform:uppercase;
  color:var(--ink-soft);margin:22px 0 10px}
.row{display:flex;gap:14px;align-items:baseline;padding:13px 4px;border-bottom:1px solid var(--line)}
.row .no{font-family:var(--serif);color:var(--accent);font-size:15px;min-width:30px}
.row .t{flex:1}
.row .t b{font-family:var(--serif);font-weight:600;font-size:16.5px}
.row .t p{color:var(--ink-soft);font-size:13.5px;margin-top:3px}
.row .st{font-size:12px;color:var(--ink-soft);white-space:nowrap}
.row.done:hover{background:var(--tint);border-radius:10px}
.row.writing{opacity:.72}
.row.planned{opacity:.5}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:20px;
  background:var(--tint);color:var(--accent)}
article{margin-top:12px}
article h2{font-family:var(--serif);font-weight:600;font-size:23px;margin:34px 0 12px;line-height:1.4}
article h3{font-family:var(--serif);font-weight:600;font-size:18px;margin:26px 0 8px;color:var(--accent)}
article p{margin:14px 0;font-size:17px}
article ul,article ol{margin:12px 0 12px 22px}
article li{margin:6px 0;font-size:16.5px}
article strong{color:var(--accent);font-weight:600}
article blockquote{border-left:3px solid var(--accent);background:var(--panel);
  padding:12px 18px;margin:18px 0;border-radius:0 10px 10px 0;color:var(--ink-soft)}
article code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:.9em;
  background:var(--tint);padding:1px 6px;border-radius:6px}
article figure{margin:24px 0;text-align:center}
article img{max-width:100%;border-radius:12px}
article figcaption{color:var(--ink-soft);font-size:13px;margin-top:8px}
.plain{background:var(--tint);border:1px solid var(--line);border-radius:12px;
  padding:14px 18px;margin:18px 0}
.plain::before{content:"大白话";display:inline-block;font-size:11px;letter-spacing:1px;
  color:var(--accent);border:1px solid var(--accent);border-radius:20px;
  padding:1px 9px;margin-bottom:8px}
.plain p{margin:4px 0;font-size:15.5px;color:var(--ink)}
dfn{font-style:normal;border-bottom:1px dashed var(--accent);cursor:help}
.nav{display:flex;justify-content:space-between;gap:12px;margin-top:52px;
  padding-top:22px;border-top:1px solid var(--line)}
.nav a{flex:1;padding:14px 16px;border-radius:12px;background:var(--panel);
  border:1px solid var(--line);font-size:14px}
.nav a:hover{background:var(--tint)}
.nav .n{display:block;font-size:12px;color:var(--ink-soft);margin-bottom:3px}
.nav a.next{text-align:right}
.nav a.disabled{visibility:hidden}
.foot{margin-top:46px;color:var(--ink-soft);font-size:12.5px;text-align:center;line-height:1.9}
`;

const head = (title, book) => `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${esc(book.subtitle || book.title)}">
${book.author ? '<meta name="author" content="' + esc(book.author) + '">' : ''}
<title>${esc(title)}</title>
<style>${CSS(book)}</style></head><body><div class="wrap">`;

const foot = book => `<div class="foot">
${esc(book.title)}${book.author ? " · " + esc(book.author) : ""}<br>
${esc(book.tagline || defTagline(book))}</div></div></body></html>`;

const topbar = book => `<div class="top">
  <a class="crumb" href="${linkPath(book.slug, fileName.index)}"><span class="dot"></span>${esc(book.title)}</a>
  <a href="${shelfPath}">书架</a></div>`;

function renderIndex(book) {
  const chs = book.chapters || [];
  const rows = chs.map(c => {
    const st = c.status || "planned";
    const label = { done: "", writing: "写作中", planned: "待写" }[st] || "";
    const inner = `<span class="no">${esc(c.no != null ? pad(c.no) : "·")}</span>
      <span class="t"><b>${esc(c.title)}</b>${c.brief ? `<p>${esc(c.brief)}</p>` : ""}</span>
      ${label ? `<span class="st">${label}</span>` : `<span class="st">读 →</span>`}`;
    return st === "done"
      ? `<a class="row done" href="${linkPath(book.slug, chFile(c.no))}">${inner}</a>`
      : `<div class="row ${st}">${inner}</div>`;
  }).join("\n");
  const doneN = chs.filter(c => c.status === "done").length;
  return head(book.title, book) + topbar(book) + `
  <span class="badge">${doneN}/${chs.length} 章已发布</span>
  <h1 style="margin-top:14px">${esc(book.title)}</h1>
  ${book.subtitle ? `<p class="sub">${esc(book.subtitle)}</p>` : ""}
  <p class="meta">${esc(book.meta || defMeta(book))}</p>
  ${book.introTeaser ? `<a class="introcard" href="${linkPath(book.slug, fileName.intro)}"><b>导读 · 从这里进门</b><p>${esc(book.introTeaser)}</p></a>` : ""}
  <div class="toc"><h3>目录</h3>${rows}</div>
  ` + foot(book);
}

function renderChapter(book, no, bodyHtml) {
  const chs = book.chapters || [];
  const idx = chs.findIndex(c => Number(c.no) === Number(no));
  const c = chs[idx] || { no, title: "第 " + no + " 章" };
  const prev = chs.slice(0, idx).reverse().find(x => x.status === "done");
  const next = chs.slice(idx + 1).find(x => x.status === "done");
  const navLink = (ch, cls, lbl) => ch
    ? `<a class="${cls}" href="${linkPath(book.slug, chFile(ch.no))}"><span class="n">${lbl}</span>${esc(ch.title)}</a>`
    : `<a class="${cls} disabled"></a>`;
  return head(`${c.title} · ${book.title}`, book) + topbar(book) + `
  <p class="meta">第 ${esc(pad(c.no))} 章 / 共 ${chs.length} 章</p>
  <h1 style="margin-top:8px">${esc(c.title)}</h1>
  <article>${bodyHtml}</article>
  <div class="nav">
    ${navLink(prev, "prev", "← 上一章")}
    ${navLink(next, "next", "下一章 →")}
  </div>
  <div class="nav" style="border:none;margin-top:0;padding-top:8px">
    <a href="${linkPath(book.slug, fileName.index)}"><span class="n">目录</span>回到全书目录</a>
  </div>
  ` + foot(book);
}

function renderIntro(book, bodyHtml) {
  return head(`导读 · ${book.title}`, book) + topbar(book) + `
  <h1 style="margin-top:8px">导读</h1>
  ${book.subtitle ? `<p class="sub">${esc(book.subtitle)}</p>` : ""}
  <article>${bodyHtml}</article>
  <div class="nav"><a href="${linkPath(book.slug, fileName.index)}"><span class="n">目录</span>进入正文 →</a><a class="disabled"></a></div>
  ` + foot(book);
}

// ---------- CLI ----------
const [, , cmd, workdir, arg] = process.argv;
if (!cmd || !workdir) { console.error("用法见文件头注释"); process.exit(2); }
const book = cmd === "pull" ? null : JSON.parse(readFileSync(join(workdir, "book.json"), "utf8"));
const readFrag = p => { try { return readFileSync(join(workdir, p), "utf8"); } catch { return ""; } };

const CTYPE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
async function uploadAsset(localPath, destName) {
  const ext = (destName.match(/\.[a-z]+$/i) || [""])[0].toLowerCase();
  const ct = CTYPE[ext];
  if (!ct) { console.error(`目标名扩展不支持：${destName}（用 .png/.jpg/.jpeg/.webp）`); process.exit(1); }
  const key = `books/${book.slug}/${destName}`;
  const r = await fetch(`${API}/upload/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": ct },
    body: readFileSync(localPath),
  });
  const t = await r.text();
  if (!r.ok) { console.error(`上传失败 ${key}: ${r.status} ${t}`); process.exit(1); }
  console.log(`ok  ${key}  →  ${publicUrl(book.slug, destName)}`);
  if (destName === "cover.jpg") {
    // 封面标记归口进 book.json（书架接口读 cover/coverAt 字段，不再探测 R2 对象）。
    book.cover = true; book.coverAt = Date.now();
    writeFileSync(join(workdir, "book.json"), JSON.stringify(book, null, 2) + "\n");
    await syncBookJson(book);
  }
}

async function doIndex() {
  // 书的诞生时间：首次发布目录页时盖章进 book.json——书架接口只读 book.json，
  // 不再靠列举 R2 找最老文件当创建时间（2026-08-27 book.json 归口单一真源）。
  if (!book.createdAt) {
    book.createdAt = Date.now();
    writeFileSync(join(workdir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  }
  await upload(book.slug, fileName.index, renderIndex(book)); await syncBookJson(book);
}
async function doIntro() {
  const b = readFrag("intro.html"); if (!b) { console.error("缺 intro.html"); process.exit(1); }
  await upload(book.slug, fileName.intro, renderIntro(book, b));
  await upload(book.slug, srcName("intro.html"), b);
}
async function doChapter(no) {
  const b = readFrag(`chapters/${pad(no)}.html`);
  if (!b) { console.error(`缺 chapters/${pad(no)}.html`); process.exit(1); }
  // 发布前最后一道闸：正文是空的、或整段是评审 JSON，一律不许上线。
  // 2026-09-07 两种事故都是「status 标了 done，读者打开是空气」——见 validate.mjs。
  const v = checkChapterSource(b);
  if (!v.ok) {
    console.error(`拒绝发布第 ${pad(no)} 章：${v.reason}`);
    console.error(`  文件：${join(workdir, `chapters/${pad(no)}.html`)}`);
    console.error(`  把正文写进这个文件再重跑；别让空章带着 done 上线。`);
    process.exit(1);
  }
  await upload(book.slug, chFile(no), renderChapter(book, no, b));
  await upload(book.slug, srcName(chFile(no)), b);
  await syncBookJson(book);   // 只重发单章也要让 _src 有入口，下次 pull 才不用手工重建
}
const liveUrl = () => console.log(`\n公开链接（外网可直接打开）：\n  ${publicUrl(book.slug, fileName.index)}`);

// 过审即发（durable）：把某章标 done → 落盘状态 → 发这一章 → 刷新目录。一步到位，便于「每章过审即发」。
async function doDone(no) {
  const c = (book.chapters || []).find(x => Number(x.no) === Number(no));
  if (!c) { console.error(`book.json 里没有第 ${no} 章`); process.exit(1); }
  if (!existsSync(join(workdir, `chapters/${pad(no)}.html`))) { console.error(`缺 chapters/${pad(no)}.html，先落盘正文再 done`); process.exit(1); }
  c.status = "done";
  writeFileSync(join(workdir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  await doChapter(no);   // 发这一章
  // 相邻已发布章的上/下章导航需要因新章而更新：重渲染最近的前一个 done（补它的「下一章」）
  // 和最近的后一个 done（补它的「上一章」）。这样顺序发布/中间补发都不会留下断链。
  const chs = book.chapters || [];
  const idx = chs.findIndex(x => Number(x.no) === Number(no));
  const prevDone = chs.slice(0, idx).reverse().find(x => x.status === "done");
  const nextDone = chs.slice(idx + 1).find(x => x.status === "done");
  if (prevDone) await doChapter(prevDone.no);   // 让前章的「下一章 →」指向本章
  if (nextDone) await doChapter(nextDone.no);   // 让后章的「← 上一章」指向本章
  await doIndex();       // 刷新目录（点亮该章）
}

// 断点续跑用：列出每章 状态 + 正文是否已落盘，一眼看出还差哪些
function doStatus() {
  const chs = book.chapters || [];
  const doneN = chs.filter(c => c.status === "done").length;
  console.log(`《${book.title}》  ${doneN}/${chs.length} done  ·  slug=${book.slug}`);
  console.log(`导读 intro.html: ${readFrag("intro.html") ? "已落盘" : "缺"}`);
  for (const c of chs) {
    const onDisk = existsSync(join(workdir, `chapters/${pad(c.no)}.html`));
    const flag = c.status === "done" ? "✓ done " : (onDisk ? "· 待发(有稿)" : (c.status === "writing" ? "… 写作中" : "  待写"));
    console.log(`  ${pad(c.no)} ${flag}  ${c.title}`);
  }
  console.log(`公开入口：${publicUrl(book.slug, fileName.index)}`);
}

// 修书模式起手式：从线上 _src 把整个工作目录拉回来（book.json + 各章片段 + 导读 + 封面）。
// _src 缺失（登记簿/源稿镜像上线前出的老书）→ 报错并提示走 SKILL.md 的手工重建路径。
async function doPull(slug) {
  const pub = f => `${SITE}/voicedrop/books/${slug}/${f}`;
  const r = await fetch(pub("_src/book.json"));
  if (!r.ok) {
    console.error(`这本书没有 _src 源稿镜像（${r.status}）——是源稿镜像上线前出的老书。`);
    console.error(`按 SKILL.md「修书模式」的手工重建路径：抓渲染页 ${pub("index.html")} 提取 <article> 内容。`);
    process.exit(3);
  }
  const b = JSON.parse(await r.text());
  if (b.legacy) {
    // legacy 老书的 book.json 是 2026-08-27 归口迁移补录的书架元数据，_src 无章节源稿。
    console.error(`这是 legacy 老书（book.json 为迁移补录件），无章节源稿。`);
    console.error(`按 SKILL.md「修书模式」的手工重建路径：抓渲染页 ${pub("index.html")} 提取 <article> 内容。`);
    process.exit(3);
  }
  mkdirSync(join(workdir, "chapters"), { recursive: true });
  writeFileSync(join(workdir, "book.json"), JSON.stringify(b, null, 2) + "\n");
  console.log(`ok  book.json  （${b.title} · ${b.chapters?.length ?? 0} 章）`);
  for (const c of (b.chapters || []).filter(x => x.status === "done")) {
    const f = chFile(c.no);
    const cr = await fetch(pub(`_src/${f}`));
    if (cr.ok) { writeFileSync(join(workdir, "chapters", f), await cr.text()); console.log(`ok  chapters/${f}`); }
    else console.error(`缺章 _src/${f}（${cr.status}）——该章要按渲染页手工重建`);
  }
  const ir = await fetch(pub("_src/intro.html"));
  if (ir.ok) { writeFileSync(join(workdir, "intro.html"), await ir.text()); console.log("ok  intro.html"); }
  const cv = await fetch(pub("cover.jpg"));
  if (cv.ok) { writeFileSync(join(workdir, "cover.jpg"), Buffer.from(await cv.arrayBuffer())); console.log("ok  cover.jpg"); }
  console.log(`\n工作目录已重建：${workdir}`);
}

if (cmd === "index") { await doIndex(); liveUrl(); }
else if (cmd === "intro") await doIntro();
else if (cmd === "chapter") await doChapter(arg);
else if (cmd === "done") { await doDone(arg); }
else if (cmd === "status") { doStatus(); }
else if (cmd === "pull") {
  if (!arg) { console.error("用法：build.mjs pull <workdir> <slug>"); process.exit(2); }
  await doPull(arg);
}
else if (cmd === "asset") {
  if (!arg) { console.error("用法：build.mjs asset <workdir> <本地图片> [目标名]"); process.exit(2); }
  const dest = process.argv[5] || arg.split("/").pop();
  // 相对源路径一律先按 <workdir> 解析（找不到再按 cwd 兜底）：workspace 根目录曾有一张
  // 野 cover.jpg 被 cwd 相对路径捡走、顶掉正确封面（2026-08-16 龙餐馆/荷马书事故），别改回去。
  let src = arg;
  if (!src.startsWith("/")) {
    const inWork = join(workdir, src);
    if (existsSync(inWork)) src = inWork;
  }
  await uploadAsset(src, dest);
}
else if (cmd === "all") {
  await doIndex();
  if (readFrag("intro.html")) await doIntro();
  for (const c of (book.chapters || []).filter(x => x.status === "done")) await doChapter(c.no);
  liveUrl();
} else { console.error("未知命令：" + cmd); process.exit(2); }
