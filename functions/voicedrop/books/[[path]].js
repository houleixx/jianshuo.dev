// 公开书架：voicedrop.cn/books/<name> → R2 (bucket jianshuo-dev-files)。
//
// EdgeOne 边缘函数把非 /files|/agent|/reco 路径补 /voicedrop 前缀送到 Pages
// （infra/voicedrop-cn-edgeone/edge-function.js），所以这个函数同时服务：
//   https://voicedrop.cn/books/<name>            （干净路径，对外分享用这个）
//   https://jianshuo.dev/voicedrop/books/<name>  （同一函数的原始路径）
//
// 唯一数据源是写书 cloud agent 的 scope（users/<PUBLISHER>/books/）：agent 用
// 自己的用户 token 走 PUT /files/api/upload/books/<slug>/<file>，upload 路由把
// key 锁进调用者 scope，agent 拿不到也不该拿 FILES_TOKEN，所以公开路由迁就写端。
import { bearerToken, verifySession, anonScopeFromToken } from '../../lib/auth.js';
// 书没有 <meta name="author"> 时，按书主人 owner 显示作者名——与社区文章同一套
// （profile.name → id 前 6 位大写），2026-08-27。
import { readProfileName } from '../../lib/style-store.js';
import { setCommunityPostHidden } from '../../lib/community-index.js';
import { coreGetReport } from '../../lib/core-db.js';
// key 钉死在该 scope 的 books/ 尾段下，桶里其他东西（articles/、WECHAT.json…）
// 够不着，所以不需要 photo 那样的文件类型白名单。
//
// GET /books/        → 书架索引：与 iOS「写书」tab（BooksShelfView.swift）**完全同款**
//                      的实体书书架——两本一排 + 木搁板，第一格是「写书」入口（链到
//                      voicedrop.cn 落地页），有 cover.jpg 铺封面图，没有的用布面缺省
//                      封面（封面色按 slug 哈希稳定分配），书脊/页口/投影一比一复刻。
//                      改这边样式记得同步看 iOS 那份，两边保持一致。
//                      网页版另加：搜索框（书名/作者/章节，纯前端，章节索引懒加载
//                      ?format=search）+ 顶部类目导航（八词，见 lib/books-shelf.js，
//                      样式对齐社区 tabRow）+ 书名下类目小标签；iOS 暂无搜索与导航。
// GET /books/?format=json → 同一份索引的 JSON 版（iOS「写书」tab 图书馆用）：
//                      {books:[{slug,title,main,sub,c,c2,author,category,cover,coverAt,chapters,createdAt}]}。
//                      coverAt = cover.jpg 的上传时间戳，书架 <img> 用它当 ?v= 破缓存。
//                      cover = 该书文件夹里有没有 cover.jpg；chapters = done 的章节数。
// GET /books/?format=search → 搜索索引：{books:[{slug,title,author,category,sub,intro,
//                      toc:[{t,b}]}]}，sub = 副标题、intro = 导读钩子、toc = 章节标题+
//                      一句 brief。新书取 book.json，老书（没有 chapters 清单）抠目录页。
// GET /books/<name>  → 文件本体，inline 展示；html/md/txt 只缓存 5 分钟（书会
//                      反复重发迭代），其余（pdf/图片等大文件）缓存一天。
//
// 书架清单缓存（2026-09-15）：以上三种索引都从 readShelf() 拿同一份全量清单——R2 里
// 一份 JSON（SHELF_CACHE_KEY，1 小时 TTL），任何写进 books/<slug>/ 的上传（files API）
// 和这里的隐藏开关都会删掉它。此前每刷一次书架都逐本读 book.json（两百多次 R2 读），
// 搜索还要抠 41 本老书的目录页，不缓存扛不住。
import {
  PUBLISHER, PUBLISHER_SCOPE, SHELF_CACHE_KEY, SHELF_CACHE_TTL_MS,
  CATEGORY_ORDER, normalizeCategory, invalidateShelf,
} from '../../lib/books-shelf.js';
// 类目真源 = 各书 `_src/book.json` 的 category（写书 skill 规划大纲时自报；存量 209 本
// 于 2026-09-15 批量回填）。此前代码里那张 59 本的手写映射表已删——不认的词当没写。

const TYPES = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};

export async function onRequest({ request, env, params }) {
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  let rel = decodeURIComponent(segments.join('/'));
  if (rel.includes('..') || rel.startsWith('/')) return notFound();

  // 唯一的写入口：POST /books/<slug>/hidden {hidden:bool}（书页 ⋯ 菜单「隐藏本书」）。
  // 其余任何非 GET/HEAD 仍旧 405——别因为开了一个开关就把整个 POST 面放开。
  const hm = /^([^/]+)\/hidden$/.exec(rel);
  if (hm && request.method === 'POST') return setHidden(env, request, hm[1]);
  // GET 是「这本是我的吗、藏了吗」——阅读页开场问一句。菜单显不显示、开关打不
  // 打勾都不能依赖书单列表：那份数据可能来自 App 本地缓存或边缘缓存。读不需要
  // 登录（没 token 就是 mine:false）。
  if (hm && request.method === 'GET') return getHidden(env, request, hm[1]);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }

  // 索引页：/books 或 /books/（?format=json 给 App 吃结构化数据）
  if (!rel) {
    const format = new URL(request.url).searchParams.get('format');
    if (format === 'json') return indexJSON(env, request);
    if (format === 'search') return searchJSON(env, request);
    return index(env);
  }

  // 整本书打印视图（/books/<slug>/print）：封面+导读+全部章节拼一页、分页 CSS、
  // 无导航件——worker 的 Browser Rendering 用它渲染 PDF（走 pages.dev 域名绕 1042）。
  const pr = /^([^/]+)\/print$/.exec(rel);
  if (pr) return printView(env, pr[1]);

  const fetchKey = (key) => (request.method === 'HEAD' ? env.FILES.head(key) : env.FILES.get(key));
  let obj = await fetchKey(PUBLISHER + rel);
  // 目录路径（/books/<slug> 或 /books/<slug>/，[[path]] 不保留尾斜杠）→ 补 index.html
  if (!obj && !rel.split('/').pop().includes('.')) {
    rel = rel.replace(/\/$/, '') + '/index.html';
    obj = await fetchKey(PUBLISHER + rel);
  }
  if (!obj) return notFound();

  const ext = (rel.split('.').pop() || '').toLowerCase();
  const leaf = rel.split('/').pop();
  const headers = {
    'Content-Type': obj.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
    'Content-Length': String(obj.size),
    // inline：PDF/图片/HTML 浏览器里直接打开；filename* 让「另存为」得到原名（含中文）。
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(leaf)}`,
    // 所有可被替换重传的文件（HTML/图片/cover）都走短缓存——曾因 1 天缓存把换错的封面钉在
    // 边缘一整天（2026-08-16），又因 1 天缓存让重画的绘本页图钉住旧版（2026-08-18），别改回长缓存。
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
  };

  // 目录页（<slug>/index.html）注入「下载 PDF」链接——端点在 agent worker
  // /agent/books/pdf/<slug>（没有就现生成，有了直接下载）。绝对地址：voicedrop.cn
  // 的 EdgeOne 反代不认 /agent 路径。
  const bi = /^([^/]+)\/index\.html$/.exec(rel);
  if (bi && request.method === 'GET') {
    let html = await obj.text();
    const pdfLink = `<div style="text-align:center;margin:26px 0 40px"><a href="https://jianshuo.dev/agent/books/pdf/${encodeURIComponent(bi[1])}" style="font-size:13px;color:#A89E8E;text-decoration:none;border:1px solid rgba(51,48,42,.18);border-radius:20px;padding:8px 18px">⬇ 下载 PDF 版（首次点击需生成约一分钟）</a></div>`;
    html = html.includes('</body>') ? html.replace('</body>', pdfLink + '</body>') : html + pdfLink;
    delete headers['Content-Length'];
    return new Response(html, { headers });
  }

  // 章节页（<slug>/<非index/intro>.html）注入「听本章」播放器，
  // 音频端点见 functions/voicedrop/books/audiobook/[[path]].js。
  const ch = /^([^/]+)\/(?!index\.|intro\.)([^/]+)\.html?$/.exec(rel);
  if (ch && request.method === 'GET') {
    let html = await obj.text();
    const widget = audioWidget(ch[1], ch[2]);
    html = html.includes('</body>') ? html.replace('</body>', widget + '</body>') : html + widget;
    delete headers['Content-Length'];
    return new Response(html, { headers });
  }

  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

// 「听本章」浮动播放器。相对路径 ../audiobook/<slug>/<stem> 在两个域名下都成立
// （jianshuo.dev/voicedrop/books/... 与 voicedrop.cn/books/...）。
// 已缓存：<audio> 直连 R2 mp3（可拖、可倍速）。
// 首播（边合成边流）：不能把 chunked 流直接塞给 <audio>.src——流结束、时长从未知
// 变已知的那一刻，浏览器会把播放位置重置回 0（实测「全部生成完就跳回最开始」）。
// 改用 (Managed)MediaSource：fetch 读流、SourceBuffer 逐块喂，收完 endOfStream()
// 定格时长，播放位置不动。不支持 MSE 的浏览器（老 iOS Safari）兜底为
// 「先生成显示进度、生成完直接播 R2 缓存」，同样没有跳回问题。
function audioWidget(slug, stem) {
  return `
<div id="abw" style="position:fixed;right:18px;bottom:18px;z-index:99">
  <button id="abbtn" style="display:flex;align-items:center;gap:8px;border:1px solid rgba(51,48,42,.18);
    background:#fcf9f1;color:#33302a;border-radius:24px;padding:10px 18px;font-size:14px;
    box-shadow:0 4px 14px rgba(60,45,30,.18);cursor:pointer">🎧 听本章</button>
</div>
<script>
(function(){
  var btn=document.getElementById('abbtn'),box=document.getElementById('abw');
  var slug=${JSON.stringify(slug)},stem=${JSON.stringify(stem)};
  var srcOf=function(s){return '../audiobook/'+encodeURIComponent(slug)+'/'+encodeURIComponent(s);};
  var a=null,tipEl=null,chapters=null;
  function setTip(t){if(tipEl)tipEl.textContent=t;}

  function panel(tipText){
    box.innerHTML='<div style="background:#fcf9f1;border:1px solid rgba(51,48,42,.18);border-radius:14px;'+
      'padding:10px 14px;box-shadow:0 4px 14px rgba(60,45,30,.18);max-width:78vw">'+
      '<div id="abtip" style="font-size:12px;color:#7a7264;margin-bottom:6px"></div>'+
      '<audio id="abaudio" controls style="width:300px;max-width:72vw;display:block"></audio></div>';
    tipEl=document.getElementById('abtip');tipEl.textContent=tipText;
    a=document.getElementById('abaudio');
    a.onerror=function(){setTip('加载失败，刷新重试');};
    // 连播（2026-08-24）：一章 ended 自动接下一章。复用同一个 <audio>——首次点击
    // 已解锁元素，之后换 src + play() 不需要新手势，iOS 锁屏也能一路听到底。
    a.addEventListener('ended',chainNext);
    return a;
  }

  // 章节清单（done 升序，_src/book.json）；老书没有 _src → 退化为「编号 +1 试探」。
  function loadChapters(){
    if(chapters)return Promise.resolve(chapters);
    return fetch('../'+encodeURIComponent(slug)+'/_src/book.json').then(function(r){return r.ok?r.json():null;})
      .then(function(b){
        chapters=((b&&b.chapters)||[]).filter(function(c){return c.status==='done';})
          .map(function(c){var n=String(c.no);if(n.length<2)n='0'+n;return {stem:n,title:c.title||('第 '+c.no+' 章')};});
        return chapters;
      }).catch(function(){chapters=[];return chapters;});
  }

  function chainNext(){
    loadChapters().then(function(chs){
      var next=null;
      if(chs.length){
        for(var i=0;i<chs.length;i++) if(chs[i].stem===stem){ if(i+1<chs.length) next=chs[i+1]; break; }
      } else {
        var n=parseInt(stem,10);
        if(!isNaN(n)){var s=String(n+1);if(s.length<2)s='0'+s;next={stem:s,title:'第 '+(n+1)+' 章'};}
      }
      if(!next){setTip('全书播完 🎉');return;}
      stem=next.stem;
      playCurrent(next.title);
    });
  }

  // 播当前 stem：已缓存直接换 src；未缓存 MSE 边合成边播 / 无 MSE 先生成后播。
  function playCurrent(title){
    var label=title?('▶ '+title+' · '):'';
    fetch(srcOf(stem),{method:'HEAD'}).then(function(r){return r.ok;}).catch(function(){return false;})
    .then(function(cached){
      if(cached){
        setTip(label+'已生成，可拖动进度');
        a.src=srcOf(stem);a.play().catch(function(){});
        return;
      }
      var MS=window.ManagedMediaSource||window.MediaSource;
      if(MS&&MS.isTypeSupported&&MS.isTypeSupported('audio/mpeg')) playStreaming(MS,label);
      else generateThenPlay(label);
    });
  }

  // 边合成边播：fetch 流 → SourceBuffer 逐块 append，结束 endOfStream 定格时长。
  // 背压（2026-08-24 修「首播尾部错乱」）：合成远快于播放，整章一股脑 append 会把
  // SourceBuffer 配额撑爆（Chromium 实测 ~7.7MB、iOS 更小），appendBuffer 抛
  // QuotaExceededError——旧代码把已出队的块静默扔掉，尾部就缺块跳接。现在：
  // ①失败不出队（append 成功才 shift）；②超前播放点 60 秒就停喂，数据留在 JS
  // 内存队列（无配额），靠 timeupdate 续喂；③配额仍满时清掉已播段再等重试。
  function playStreaming(MS,label){
    setTip((label||'')+'首次播放：边合成边播（此次不能拖动，下次即可）');
    var ms=new MS();
    if('disableRemotePlayback' in a) a.disableRemotePlayback=true;  // ManagedMediaSource 要求
    a.src=URL.createObjectURL(ms);
    ms.addEventListener('sourceopen',function(){
      var sb=ms.addSourceBuffer('audio/mpeg');
      var queue=[],done=false,busy=false,AHEAD=60;
      function ahead(){
        try{if(sb.buffered.length) return sb.buffered.end(sb.buffered.length-1)-a.currentTime;}catch(e){}
        return 0;
      }
      function pump(){
        if(busy||sb.updating) return;
        if(queue.length){
          if(ahead()>AHEAD) return;                       // 缓冲够超前了，等 timeupdate 再喂
          busy=true;
          try{sb.appendBuffer(queue[0]);queue.shift();}   // 成功才出队，失败块不丢
          catch(e){
            busy=false;
            // 配额满：清掉已播过的段腾地方，updateend 后自动重试
            try{if(a.currentTime>30){busy=true;sb.remove(0,a.currentTime-15);}}catch(e2){}
          }
        }
        else if(done&&ms.readyState==='open'){try{ms.endOfStream();}catch(e){}}
      }
      sb.addEventListener('updateend',function(){busy=false;pump();});
      a.ontimeupdate=pump;   // 属性式：连播多章不累积旧监听器
      fetch(srcOf(stem)).then(function(r){
        if(!r.ok) throw 0;
        var rd=r.body.getReader();
        (function step(){rd.read().then(function(x){
          if(x.done){done=true;pump();return;}
          queue.push(x.value);pump();step();
        }).catch(function(){done=true;pump();});})();
      }).catch(function(){document.getElementById('abtip').textContent='生成失败，刷新重试';});
    },{once:true});
    a.play().catch(function(){});
  }

  // 无 MSE 兜底：先拉完整个流（显示生成进度），生成完直接播 R2 缓存版。
  function generateThenPlay(label){
    setTip((label||'')+'正在生成本章音频…');
    fetch(srcOf(stem)).then(function(r){
      if(!r.ok) throw 0;
      var rd=r.body.getReader(),got=0;
      function step(){return rd.read().then(function(x){
        if(x.done) return;
        got+=x.value.length;
        setTip((label||'')+'正在生成 '+Math.round(got/1024)+' KB…');
        return step();
      });}
      return step();
    }).then(function(){
      setTip((label||'')+'已生成，可拖动进度');
      a.src=srcOf(stem);a.play().catch(function(){});
    }).catch(function(){setTip('生成失败，刷新重试');});
  }

  btn.onclick=function(){
    btn.disabled=true;btn.textContent='准备中…';
    panel('准备中…');
    loadChapters();   // 预取章节清单，连播时零等待
    playCurrent(null);
  };
})();
</script>`;
}

// ---------- 整本书打印视图（PDF 渲染源）----------
// 保真原则（2026-08-23 v2）：**原样复用章节页自带的 <style>**（build.mjs 那套淡雅
// 界面——纸底、衬线标题、accent 色、引用块），PDF 和网页同一套字体颜色；只叠加
// 分页规则。每章取「meta 行 + 标题 + <article> 正文」，导航件/播放器/页脚不进。
// <base> 指向 pages.dev：相对图片路径在 Browser Rendering 里可加载（1042 规避）。
async function printView(env, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return notFound();
  let book = null;
  try {
    const o = await env.FILES.get(`${PUBLISHER}${slug}/_src/book.json`);
    if (o) book = JSON.parse(await o.text());
  } catch {}

  const page = async (file) => {
    const o = await env.FILES.get(`${PUBLISHER}${slug}/${file}`);
    return o ? await o.text() : null;
  };
  const pick = (html, re) => (re.exec(html) || [])[0] || '';
  const grabArticle = (html) => pick(html, /<article[^>]*>[\s\S]*?<\/article>/i);

  // 章节清单：book.json 优先；老书（无 _src）扫 R2 里的 NN.html
  let files = [];
  let title = String(book?.title ?? '');
  if (book?.chapters?.length) {
    files = book.chapters.filter((c) => c.status === 'done').map((c) => `${String(c.no).padStart(2, '0')}.html`);
  } else {
    const listed = await env.FILES.list({ prefix: `${PUBLISHER}${slug}/`, limit: 200 });
    files = (listed.objects || [])
      .map((o) => o.key.slice(`${PUBLISHER}${slug}/`.length))
      .filter((f) => /^\d\d\.html$/.test(f))
      .sort();
  }
  if (!files.length) return notFound();

  // 逐章取原页面片段；站点 CSS 从第一张有效章节页原样搬来
  let siteCss = '';
  const sections = [];
  for (const f of files) {
    const html = await page(f);
    if (!html) continue;
    if (!siteCss) siteCss = pick(html, /<style>[\s\S]*?<\/style>/i);
    const body = pick(html, /<p class="meta">[\s\S]*?<\/p>/i) + pick(html, /<h1[^>]*>[\s\S]*?<\/h1>/i) + grabArticle(html);
    if (body) sections.push(`<section class="chapter">${body}</section>`);
  }
  if (!sections.length) return notFound();
  const introHtml = await page('intro.html');
  const intro = introHtml
    ? pick(introHtml, /<h1[^>]*>[\s\S]*?<\/h1>/i) + pick(introHtml, /<p class="sub">[\s\S]*?<\/p>/i) + grabArticle(introHtml)
    : '';
  if (!title) {
    const idx = await page('index.html');
    if (idx) title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(idx) || [])[1] || slug).split('·')[0].trim();
  }
  if (!siteCss) siteCss = '<style>body{font-family:-apple-system,"PingFang SC",sans-serif;color:#2A2521;line-height:1.85}</style>';

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="https://jianshuo-dev.pages.dev/voicedrop/books/${encodeURIComponent(slug)}/">
<title>${esc(title || slug)}</title>
${siteCss}
<style>
  /* 打印叠加：只管分页与纸面，观感全部沿用上面的站点样式 */
  @page { size: A4; margin: 16mm 14mm; }
  body { background: var(--paper, #FAF6EF); min-height: auto; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0; }
  .chapter { page-break-before: always; }
  .cover { page-break-after: always; text-align: center; padding-top: 290px; min-height: 900px; }
  .cover h1 { font-size: 40px; }
  .cover .sub { font-size: 17px; margin-top: 14px; }
  .cover .author { margin-top: 34px; color: var(--ink-soft, #7a7264); font-size: 15px; }
  .cover .tag { margin-top: 120px; color: var(--ink-soft, #7a7264); font-size: 12.5px; }
  h1, h2, h3 { page-break-after: avoid; }
  article img, article figure, article blockquote, .plain { page-break-inside: avoid; }
</style></head><body><div class="wrap">
<div class="cover">
  <h1>${esc(title || slug)}</h1>
  ${book?.subtitle ? `<p class="sub">${esc(book.subtitle)}</p>` : ''}
  ${book?.author ? `<p class="author">${esc(book.author)}</p>` : ''}
  ${book?.tagline || book?.meta ? `<p class="tag">${esc(book.tagline || book.meta)}</p>` : ''}
</div>
${intro ? `<section class="chapter">${intro}</section>` : ''}
${sections.join('\n')}
<div class="foot">${esc(title || slug)}${book?.author ? ' · ' + esc(book.author) : ''}</div>
</div></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function notFound() {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// 书封样式：竖排题签（主标题）+ 竖排小字副题 + 「建硕」印章，
// 封面色从传统矿物色里按 slug 哈希稳定分配（同一本书永远同一个颜色）。
const PALETTE = [
  ['#33506B', '#263D54'], ['#A04A38', '#7E3626'], ['#3D6B57', '#2C5342'],
  ['#5A4157', '#463043'], ['#40403C', '#2F2F2C'], ['#A67F42', '#8A6730'],
  ['#2E4159', '#223146'], ['#7A4A2E', '#603921'], ['#8A3A4A', '#6E2C39'],
  ['#5A6B3D', '#47552E'], ['#35597E', '#284664'],
];
const colorOf = (slug) => {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.codePointAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
};
// 主副题拆分：在 ——／：／· 处断开，题签只放主题，副题竖排在封面右侧。
const splitTitle = (t) => {
  for (const sep of ['——', '—', '：', ':', ' · ', '·']) {
    const i = t.indexOf(sep);
    if (i > 1) return [t.slice(0, i).trim(), t.slice(i + sep.length).trim()];
  }
  return [t.trim(), ''];
};

/// 书架数据（2026-08-27 book.json 归口）：一个 delimiter listing 拿书的文件夹，
/// 再逐本**只读 `_src/book.json`**——title/author/category/hidden/owner/createdAt/
/// cover/coverAt/章节数全部以它为单一真源（build.mjs 发布时维护；存量书由归口
/// 迁移一次性补齐，老书补录件带 legacy:true）。此前的「读 index.html 抠标题 +
/// 全量列文件夹考古时间戳」已废——那套是每刷 ~350 次 R2 操作、9 秒的元凶。
/// listing 必须 cursor 翻页：R2 delimited list 按「扫过的 key 数」截断，不是按
/// 返回的前缀数（admin/llm 页曾因此冻在 2026-07-13）。
/// 全量清单（不分请求者、含 hidden 书与 owner）：每本
/// {slug,title,author,category,hidden,owner,cover,coverAt,chapters,createdAt,subtitle,intro,toc}。
/// 这是缓存的那份；collectBooks / searchJSON 再按请求者过滤、按用途裁字段。
async function buildShelf(env) {
  const slugs = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: PUBLISHER, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
    slugs.push(...(listed.delimitedPrefixes || []).map((p) => p.slice(PUBLISHER.length).replace(/\/$/, '')).filter(Boolean));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const books = (await Promise.all(slugs.map(async (slug) => {
    let b = null;
    try {
      const o = await env.FILES.get(`${PUBLISHER}${slug}/_src/book.json`);
      if (o) b = JSON.parse(await o.text());
    } catch {}
    // 上架条件 = book.json 存在且 createdAt 已盖章（build.mjs 首次发布目录页时盖）。
    // 失败/流产任务只留 _src 空壳、没有 createdAt → 不上架（幽灵书拦截，语义与
    // 旧的「看 index.html 存在」一致）。
    if (!b || !b.createdAt) return null;
    // 作者：book.json 自报优先；没有的按书主人 owner 显示 profile.name（没设置则
    // id 前 6 位大写），owner 缺失的老书回落发布者账号（ae209ac5 → 建硕）。
    let author = String(b.author || '').trim().slice(0, 20);
    if (!author) {
      try { author = await readProfileName(env, b.owner || PUBLISHER_SCOPE, { fallback: 'id' }); }
      catch {}
    }
    const title = String(b.title || slug);
    const category = normalizeCategory(b.category);
    // 章节：chapters 数组数 done（新书）；迁移补录的老书存的是数值 chaptersCount。
    const list = Array.isArray(b.chapters) ? b.chapters.filter((x) => x && x.status === 'done') : null;
    const chapters = list ? list.length : (Number(b.chaptersCount) || 0);
    // 搜索用的目录：新书直接用 book.json 的 done 章节；老书没有清单，抠目录页。
    let subtitle = String(b.subtitle || '').trim();
    let intro = String(b.introTeaser || '').trim();
    let toc;
    if (list) {
      toc = list.map((x) => ({ t: String(x.title || '').trim(), b: String(x.brief || '').trim() }));
    } else {
      const s = await scrapeLegacyToc(env, slug);
      toc = s.toc; subtitle = subtitle || s.sub; intro = intro || s.intro;
    }
    // 归属口径与 setHidden 一致：owner 缺失的老书算发布者的。
    return { slug, title, author, category, hidden: b.hidden === true, owner: b.owner || PUBLISHER_SCOPE,
             cover: b.cover === true, coverAt: Number(b.coverAt) || 0,
             chapters, createdAt: Number(b.createdAt) || 0, subtitle, intro, toc };
  }))).filter(Boolean);
  // 时间倒序：最新的书在最前面（同龄兜底按书名，保证顺序稳定）。
  books.sort((a, b) => (b.createdAt - a.createdAt) || String(a.title).localeCompare(String(b.title), 'zh'));
  return books;
}

/// 老书（2026-08-15 `_src` 上线前发的 41 本）的目录页：<p class="sub">副题、introcard 里
/// 的 <p> 导读、每行 <span class="t"><b>章题</b><p>一句</p></span>。最老的几本模板不同、
/// 抠不到章节就空着——书名副题已足够搜。抠不到绝不 throw。
const untag = (s) => String(s || '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();
async function scrapeLegacyToc(env, slug) {
  const out = { sub: '', intro: '', toc: [] };
  try {
    const o = await env.FILES.get(`${PUBLISHER}${slug}/index.html`);
    if (!o) return out;
    const t = await o.text();
    out.sub = untag((/class="sub"[^>]*>(.*?)<\//s.exec(t) || [])[1]);
    out.intro = untag((/class="introcard".*?<p>(.*?)<\/p>/s.exec(t) || [])[1]);
    for (const m of t.matchAll(/<span class="t">\s*<b>(.*?)<\/b>\s*(?:<p>(.*?)<\/p>)?/gs)) {
      out.toc.push({ t: untag(m[1]), b: untag(m[2]) });
    }
  } catch {}
  return out;
}

/// 全量清单，R2 缓存优先（builtAt 在 TTL 内才算）；没有/过期就现算并写回。
/// 写回失败不影响本次响应——最多下次再算一遍。
async function readShelf(env) {
  try {
    const o = await env.FILES.get(SHELF_CACHE_KEY);
    if (o) {
      const c = JSON.parse(await o.text());
      if (c && Array.isArray(c.books) && Date.now() - (Number(c.builtAt) || 0) < SHELF_CACHE_TTL_MS) return c.books;
    }
  } catch {}
  const books = await buildShelf(env);
  try {
    await env.FILES.put(SHELF_CACHE_KEY, JSON.stringify({ builtAt: Date.now(), books }),
      { httpMetadata: { contentType: 'application/json' } });
  } catch {}
  return books;
}

/// 请求者能看到的书（hidden 书只有主人看得到）。
const visibleTo = (books, viewerScope) =>
  books.filter((b) => !b.hidden || (!!viewerScope && b.owner === viewerScope));

/// 书架条目（HTML 书架与 ?format=json 共用）。
async function collectBooks(env, viewerScope = '') {
  const all = await readShelf(env);
  // hidden 书主人例外（2026-08-23）：带登录态且 owner == 请求者时仍列出、条目标
  // hidden——App 书架贴「隐藏」角标；别人看不见。
  return visibleTo(all, viewerScope).map((b) => {
    const [main, sub] = splitTitle(b.title);
    const [c, c2] = colorOf(b.slug);
    // mine：这本是不是请求者自己的。App 的 ⋯ 菜单据此决定「隐藏本书 / 修改这本书」
    // 显不显示——ShelfBook 里原本没有任何归属字段，客户端无从判断（2026-08-31：
    // 建硕在别人的书上点隐藏，服务端 403，App 只能笼统说「没改成」）。归属口径与
    // setHidden 一致：owner 缺失的老书算发布者的。匿名访客一律不带。
    const mine = !!viewerScope && b.owner === viewerScope;
    return { slug: b.slug, title: b.title, main, sub, c, c2, author: b.author, category: b.category,
             cover: b.cover, coverAt: b.coverAt, chapters: b.chapters, createdAt: b.createdAt,
             ...(b.hidden ? { hidden: true } : {}),
             ...(mine ? { mine: true } : {}) };
  });
}

const jsonResp = (x, status = 200) => new Response(JSON.stringify(x), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/// bearer → 请求者 scope（session JWT 优先，匿名 token 兜底）。拿不到给 ''。
/// 书单用它决定「自己的 hidden 书要不要列出来」，隐藏开关用它认主人——同一套口径。
async function viewerScope(env, request) {
  const tok = bearerToken(request);
  if (!tok) return '';
  try {
    if (env.SESSION_SECRET) {
      const s = await verifySession(tok, env.SESSION_SECRET);
      if (s && s.scope) return s.scope;
    }
    return (await anonScopeFromToken(tok)) || '';
  } catch { return ''; }
}

/// GET /books/<slug>/hidden → {slug, hidden, mine}。纯读、不需要登录：
/// 别人/匿名问就是 mine:false（不是 403——查不等于改）。归属口径与 setHidden、
/// 书单的 mine 三处完全一致：owner 缺失的老书算发布者的。
async function getHidden(env, request, slug) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(slug)) return jsonResp({ error: 'bad slug' }, 400);
  const obj = await env.FILES.get(`${PUBLISHER}${slug}/_src/book.json`);
  if (!obj) return jsonResp({ error: 'not found' }, 404);
  let doc;
  try { doc = JSON.parse(await obj.text()); } catch { return jsonResp({ error: 'bad book.json' }, 500); }
  const scope = await viewerScope(env, request);
  const mine = !!scope && (doc.owner || PUBLISHER_SCOPE) === scope;
  return jsonResp({ slug, hidden: doc.hidden === true, mine });
}

/// POST /books/<slug>/hidden {hidden:bool} —— 书页 ⋯ 菜单的「隐藏本书」开关。
/// 改的是 `_src/book.json` 的 hidden 字段，也就是 collectBooks 判「列不列」读的
/// 那份真源；页面 HTML 是构建产物、不受影响（隐藏只影响书架列表，直链照样能看，
/// 与写书 skill 里绘本缺省 hidden 的语义完全一致）。
/// 归属口径与书单一致：`_src/book.json` 的 owner，老书没有就算发布者的
/// （PUBLISHER_SCOPE），否则存量老书会变成谁都藏不了。
async function setHidden(env, request, slug) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(slug)) return jsonResp({ error: 'bad slug' }, 400);
  const scope = await viewerScope(env, request);
  if (!scope) return jsonResp({ error: 'unauthorized' }, 401);

  const key = `${PUBLISHER}${slug}/_src/book.json`;
  const obj = await env.FILES.get(key);
  if (!obj) return jsonResp({ error: 'not found' }, 404);
  let doc;
  try { doc = JSON.parse(await obj.text()); } catch { return jsonResp({ error: 'bad book.json' }, 500); }
  const owner = doc.owner || PUBLISHER_SCOPE;
  if (owner !== scope) return jsonResp({ error: 'not owner' }, 403);

  const body = await request.json().catch(() => ({}));
  const hidden = body && body.hidden === true;
  // 取消隐藏是**删字段**而不是写 false：源稿保持干净，build.mjs 重发时也不会
  // 凭空多出一行（collectBooks 判的是 `=== true`，两种写法都能工作）。
  if (hidden) doc.hidden = true; else delete doc.hidden;
  await env.FILES.put(key, JSON.stringify(doc, null, 2),
    { httpMetadata: { contentType: 'application/json' } });
  await invalidateShelf(env);   // 这里直接写 R2、不经 files API，得自己作废书架缓存
  // 社区索引同步（2026-09-06）：书架和社区是两套存储——只改 book.json 的话书从书架
  // 消失了，社区 feed 里那张书卡还挂着（feed 查的是 community_posts 的 WHERE hidden=0），
  // 隐藏只做了一半。取消隐藏不能无脑写 0：被举报的帖子也是靠这一列压着的，回落查一次
  // 举报态，口径与 files API 的 indexUpsert 一致。索引写失败不影响隐藏本身（真源已经
  // 落了 R2），书帖重登记 / 对账会收敛。
  try {
    const hid = hidden ? true : !!(await coreGetReport(env, 'book-' + slug));
    await setCommunityPostHidden(env.RECO_DB, 'book-' + slug, hid);
  } catch (e) {
    console.log('[books] community index sync failed', slug, String(e?.message || e));
  }
  return jsonResp({ ok: true, slug, hidden });
}

/// JSON 索引（iOS 图书馆）。cover / chapters / createdAt 已在 collectBooks 里
/// 随全量列举一并算好，这里直接吐。
async function indexJSON(env, request) {
  // 登录态（可选）：带 bearer 时把「自己的 hidden 书」也列出（条目带 hidden:true），
  // App 书架据此贴「隐藏」角标。带个人内容的响应 no-store——绝不进共享缓存
  // （CF 边缘 / EdgeOne 都不许把带登录态的书单缓存到别人头上）。
  const scope = await viewerScope(env, request);
  const books = await collectBooks(env, scope);
  return new Response(JSON.stringify({ books }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': scope ? 'no-store' : 'public, max-age=60',
      // Vary 必须**永远**带：匿名那份（public, max-age=60）没有 mine/hidden，
      // 少了 Vary 就可能被共享缓存喂给带登录态的请求，登录用户看到的书单里
      // 自己的书既没有 mine 也没有隐藏角标（2026-08-31 踩过）。
      Vary: 'Authorization',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/// 搜索索引（书架页搜索框懒加载）：书名/作者/类目页面上已有，这里补副标题、导读、
/// 章节标题+一句 brief——两百本约两三百 KB，浏览器里子串匹配就够，中文不用分词。
/// 可见性口径与书单完全一致（自己的 hidden 书带 token 才进）。
async function searchJSON(env, request) {
  const scope = await viewerScope(env, request);
  const all = await readShelf(env);
  const books = visibleTo(all, scope).map((b) => ({
    slug: b.slug, title: b.title, author: b.author, category: b.category,
    sub: b.subtitle || '', intro: b.intro || '', toc: Array.isArray(b.toc) ? b.toc : [],
  }));
  return new Response(JSON.stringify({ books }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': scope ? 'no-store' : 'public, max-age=300',
      Vary: 'Authorization',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 与 iOS BooksShelfView.swift 一比一：色值 / 圆角 / 间距 / 阴影都从那边抄，
// 改任何一边都要同步另一边。SwiftUI shadow(radius:r) ≈ CSS blur 2r。
async function index(env) {
  const books = await collectBooks(env);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const metaLine = (b) => {
    const base = b.chapters > 0 ? `${b.chapters} 章` : (b.sub ? esc(b.sub) : '');
    const tag = b.category ? `<span class="tag">${esc(b.category)}</span>` : '';
    return (base || tag) ? `${base}${base && tag ? ' ' : ''}${tag}` : '&nbsp;';
  };

  const bookCell = (b) => {
    const href = `/books/${encodeURI(b.slug)}/`;
    const face = b.cover
      ? `<img src="${href}cover.jpg?v=${b.coverAt}" alt="" loading="lazy">`
      : `<span class="cloth"><b>${esc(b.main)}</b><i></i>${b.sub ? `<small>${esc(b.sub)}</small>` : ''}</span>`;
    return `<a class="cell" href="${href}" title="${esc(b.title)}" data-cat="${esc(b.category)}" data-slug="${esc(b.slug)}" data-author="${esc(b.author)}">` +
      `<span class="cover" style="--c:${b.c};--c2:${b.c2}">${face}<i class="spine"></i><i class="edge"></i></span>` +
      `<span class="cap"><b>${esc(b.main)}</b><small>${metaLine(b)}</small></span></a>`;
  };
  // 第一格固定是「写书」入口（App 里开 BookWritingSheet，网页上进 VoiceDrop 落地页）。
  const writeCell = `<a class="cell" href="/">` +
    `<span class="coverW"><span class="plus">+</span><span class="wz">写书</span></span>` +
    `<span class="cap"><b>写一本新书</b><small>&nbsp;</small></span></a>`;

  const cells = [writeCell, ...books.map(bookCell)];
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<div class="row">${cells[i]}${cells[i + 1] || '<span></span>'}</div><div class="shelfbar"></div>`);
  }

  // 分类导航：与社区 tab 同款（选中墨色加粗，未选中 metaChrome），只列实际有书的类目。
  const present = CATEGORY_ORDER.filter((c) => books.some((b) => b.category === c));
  const tabs = ['全部', ...present]
    .map((c, i) => `<a href="#" data-cat="${c === '全部' ? '' : esc(c)}"${i === 0 ? ' class="on"' : ''}>${esc(c)}</a>`)
    .join('');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>书架 · VoiceDrop</title>
<style>
  /* 逐项对应 BooksShelfView.swift：appBG FAF6EF / ink 2A2521 / metaChrome A89E8E /
     recordRed E5392E / 奶油白 F7F1DF / 搁板 E3D7C2→C9B99E */
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:#FAF6EF;color:#2A2521;
    font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:440px;margin:0 auto;padding:6px 20px 44px}
  /* minmax(0,1fr)：1fr 的隐式 min-content 下限会被 nowrap 长书名撑破列宽
     （封面按 0.7 比例跟着变高，同排两本高矮不一），钉死为 0 让 ellipsis 生效。 */
  .row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px;align-items:start}
  .cell{display:block;text-decoration:none;-webkit-tap-highlight-color:transparent}
  .cover,.coverW{position:relative;display:block;aspect-ratio:0.7;overflow:hidden;
    border-radius:2px 5px 5px 2px}
  .cover{background:linear-gradient(135deg,var(--c),var(--c2));
    box-shadow:0 7px 16px rgba(60,45,30,.35),0 2px 4px rgba(60,45,30,.20)}
  .cover::before{content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(190px at 25% 15%,rgba(255,255,255,.10),transparent)}
  .cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .cloth{position:absolute;inset:0;padding:26px 16px 0 24px;display:block}
  .cloth b{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:22px;font-weight:700;letter-spacing:3px;line-height:1.36;color:#F7F1DF;
    text-shadow:0 1px 3px rgba(0,0,0,.35)}
  .cloth i{display:block;width:26px;height:1px;background:rgba(247,241,223,.55);margin:9px 0}
  .cloth small{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:11.5px;line-height:1.55;color:rgba(247,241,223,.72)}
  .spine{position:absolute;inset:0 auto 0 0;width:13px;pointer-events:none;
    background:linear-gradient(90deg,rgba(0,0,0,.36) 0,rgba(0,0,0,.10) 55%,rgba(255,255,255,.12) 100%)}
  .edge{position:absolute;inset:0 0 0 auto;width:3px;pointer-events:none;
    background:repeating-linear-gradient(180deg,rgba(255,255,255,.85) 0 1px,rgba(214,202,180,.9) 1px 2px)}
  .coverW{background:#F3ECE0;border:1.5px dashed #CFC0A6;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px}
  .plus{width:34px;height:34px;border-radius:50%;background:#E5392E;color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;
    line-height:1;box-shadow:0 3px 9px rgba(229,57,46,.30)}
  .wz{font-size:15px;font-weight:600;letter-spacing:1px;color:#6F685D}
  .cap{display:block;margin-top:9px}
  .cap b{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:14.5px;font-weight:600;color:#2A2521;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cap small{display:block;margin-top:2px;font-size:12.5px;color:#A89E8E;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .shelfbar{height:6px;border-radius:1px;margin:8px -6px 14px;
    background:linear-gradient(#E3D7C2,#C9B99E);
    box-shadow:0 3px 7px rgba(120,95,60,.18)}
  /* 分类导航（对齐社区 tabRow：15px，选中 ink 600、未选中 metaChrome）。 */
  .tabs{display:flex;gap:18px;overflow-x:auto;-webkit-overflow-scrolling:touch;
    scrollbar-width:none;padding:10px 2px 14px;white-space:nowrap}
  .tabs::-webkit-scrollbar{display:none}
  .tabs a{font-size:15px;color:#A89E8E;text-decoration:none;flex:none;
    -webkit-tap-highlight-color:transparent}
  .tabs a.on{color:#2A2521;font-weight:600}
  /* 书名下的小类目标签：随 cap small 一行，浅棕描边小胶囊。 */
  .tag{display:inline-block;font-size:10.5px;line-height:1;color:#8A7F6C;
    border:1px solid #D8CCB6;border-radius:8px;padding:2.5px 6px;vertical-align:1px}
  /* 搜索框：奶油白圆角条，与「写书」空格同一套浅底；输入后右侧出 × 清除。 */
  .search{display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;
    background:#F3ECE0;border:1px solid #E3D7C2;border-radius:12px}
  .search svg{flex:none;width:15px;height:15px;stroke:#A89E8E;fill:none;stroke-width:2;stroke-linecap:round}
  .search input{flex:1;min-width:0;border:0;background:transparent;font:inherit;font-size:15px;
    color:#2A2521;outline:none;-webkit-appearance:none;appearance:none}
  .search input::placeholder{color:#A89E8E}
  .search input::-webkit-search-cancel-button{display:none}
  .search .clr{display:none;flex:none;border:0;width:18px;height:18px;border-radius:50%;
    background:#D8CCB6;color:#fff;font-size:13px;line-height:18px;padding:0;cursor:pointer}
  .search.has .clr{display:block}
  .empty{color:#A89E8E;text-align:center;padding:44px 0 20px;font-size:14px}
  /* 章节命中提示：只匹配到章节而不是书名时，在类目行下多出一行「第三章 · …」 */
  .hit{display:block;margin-top:2px;font-size:12px;color:#8A7F6C;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head>
<body><main>
<form class="search" id="search" onsubmit="return false">
  <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
  <input id="q" type="search" placeholder="搜书名、作者、章节" autocomplete="off" autocorrect="off" spellcheck="false">
  <button type="button" class="clr" id="qclr" aria-label="清除">×</button>
</form>
<nav class="tabs">${tabs}</nav>
<div id="shelf">
${rows.join('\n')}
</div>
</main>
<script>
(function(){
  var tabs=document.querySelectorAll('.tabs a');
  var shelf=document.getElementById('shelf');
  var form=document.getElementById('search'),q=document.getElementById('q'),qclr=document.getElementById('qclr');
  var all=[].slice.call(shelf.querySelectorAll('a.cell'));
  var write=all.shift();                       // 第一格「写书」入口，任何类目下都在
  var cat='';                                  // 当前类目 tab
  var idx=null,idxLoading=false;               // 章节索引：第一次打字才拉 ?format=search
  all.forEach(function(c){
    c._q=((c.getAttribute('title')||'')+' '+(c.getAttribute('data-author')||'')+' '+(c.getAttribute('data-cat')||'')).toLowerCase();
  });
  // 章节索引里的命中：返回命中的章节标题（书名没中、章节中了时页面上提示一行），没中 false。
  function tocHit(e,kw){
    if(!e)return false;
    if((e.sub||'').toLowerCase().indexOf(kw)>=0||(e.intro||'').toLowerCase().indexOf(kw)>=0)return true;
    var toc=e.toc||[];
    for(var i=0;i<toc.length;i++){
      if(((toc[i].t||'')+' '+(toc[i].b||'')).toLowerCase().indexOf(kw)>=0)return toc[i].t||true;
    }
    return false;
  }
  function setHit(c,text){
    var old=c.querySelector('.hit');
    if(old)old.parentNode.removeChild(old);
    if(text&&typeof text==='string'){
      var h=document.createElement('span');h.className='hit';h.textContent=text;
      c.querySelector('.cap').appendChild(h);
    }
  }
  function render(){
    var kw=q.value.trim().toLowerCase();
    form.classList.toggle('has',!!kw);
    var list=all.filter(function(c){
      if(cat&&c.getAttribute('data-cat')!==cat)return false;
      if(!kw){setHit(c,null);return true;}
      if(c._q.indexOf(kw)>=0){setHit(c,null);return true;}
      var h=idx?tocHit(idx[c.getAttribute('data-slug')],kw):false;
      if(h){setHit(c,h);return true;}
      return false;
    });
    var cells=kw?list:[write].concat(list);   // 搜索时只出结果，不带「写书」格
    shelf.textContent='';
    if(!cells.length){
      var em=document.createElement('div');em.className='empty';
      em.textContent=idxLoading?'正在翻章节…':'没有找到「'+q.value.trim()+'」';
      shelf.appendChild(em);return;
    }
    for(var i=0;i<cells.length;i+=2){
      var row=document.createElement('div');row.className='row';
      row.appendChild(cells[i]);
      if(cells[i+1])row.appendChild(cells[i+1]);else row.appendChild(document.createElement('span'));
      shelf.appendChild(row);
      var bar=document.createElement('div');bar.className='shelfbar';
      shelf.appendChild(bar);
    }
  }
  function loadIndex(){
    if(idx||idxLoading)return;
    idxLoading=true;
    fetch(location.pathname+'?format=search').then(function(r){return r.json();}).then(function(d){
      idx={};(d.books||[]).forEach(function(b){idx[b.slug]=b;});
    }).catch(function(){idx={};}).then(function(){idxLoading=false;render();});
  }
  q.addEventListener('input',function(){if(q.value.trim())loadIndex();render();});
  qclr.addEventListener('click',function(){q.value='';render();q.focus();});
  [].forEach.call(tabs,function(t){
    t.addEventListener('click',function(e){
      e.preventDefault();
      [].forEach.call(tabs,function(x){x.classList.remove('on');});
      t.classList.add('on');
      cat=t.getAttribute('data-cat')||'';
      render();
    });
  });
})();
</script>
</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
