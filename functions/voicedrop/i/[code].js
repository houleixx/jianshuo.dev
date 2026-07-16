// functions/voicedrop/i/[code].js — 邀请落地页（设计稿 Invite.dc.html 1c）。
//
// URL:  https://voicedrop.cn/i/<码>  （经备案接入点反代 = /voicedrop/i/<码>，
//        jianshuo.dev/voicedrop/i/<码> 直连同样命中）
// 码由 GET /agent/referral/link 写穿到 R2 invites/<码> → {owner, name, ts}。
// 本页只做三件事：展示品牌下载页（「X 邀请你」）、写 IP 指纹（归因第 2 层）、
// 下载点击把本页 URL 写进剪贴板（归因第 3 层）。已装用户在 Safari 点链接根本
// 到不了这里——universal link 直接拉起 App（归因第 1 层）。
import { metaTags } from "../[token].js";
import { writeRefhit, ipHash } from "../../lib/refhits.js";
import { phCapture } from "../../lib/posthog.js";

const APP_STORE = "https://apps.apple.com/cn/app/id6781565141";
const ANDROID_DL = "https://jianshuo.dev/voicedrop/apk/";
const SUANLI_PER_ARTICLE = 9; // 与 App 的 Suanli.perArticle 一致（「约可成文 N 篇」）

export async function onRequest(context) {
  const { params, env, request } = context;
  const raw = String(params.code || "");
  if (!/^[A-Za-z0-9]{6,16}$/.test(raw)) return context.next();
  const code = raw.toUpperCase();

  const obj = await env.FILES.get(`invites/${code}`);
  if (!obj) return notFound();
  let inv;
  try { inv = JSON.parse(await obj.text()); } catch { return notFound(); }
  if (!inv || !/^users\/[^/]+\/$/.test(inv.owner || "")) return notFound();
  const name = String(inv.name || "").trim();

  // 归因第 2 层：IP 指纹（与文章分享页同一套 refhits，R2 lifecycle 2 天）。
  // ⚠️ 只在直连（jianshuo.dev）时于服务端写——voicedrop.cn 经腾讯云反代，这里的
  // CF-Connecting-IP 是代理出口 IP，写了也是垃圾；反代流量由页面里的第一方
  // beacon（浏览器直连 /agent/referral/hit）补真实 IP。
  const fwdHost = request.headers?.get?.("x-forwarded-host");
  const ip = request.headers?.get?.("CF-Connecting-IP");
  const visitorId = ip && env.SESSION_SECRET ? await ipHash(ip, env.SESSION_SECRET) : `anon-${code}`;
  if (!fwdHost && ip && env.SESSION_SECRET && context.waitUntil) {
    context.waitUntil(
      writeRefhit({ FILES: env.FILES }, ip, env.SESSION_SECRET, inv.owner, code, Date.now())
        .catch(() => {}));
  }

  // 漏斗打点（元数据 only；distinct_id = ipHash，claim 侧带同一 hash 可在 PostHog 里串起漏斗）。
  const ua = String(request.headers?.get?.("user-agent") || "");
  const platform = /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "other";
  const inWeChat = /MicroMessenger/i.test(ua);
  const url0 = new URL(request.url);
  if (url0.searchParams.get("c") === "1") {
    // 下载点击 beacon（页面 keep() 发的，见 invitePageHtml）：打点后 204，不再渲染整页。
    if (context.waitUntil) context.waitUntil(phCapture(env, "邀请下载点击", visitorId, { 码: code, 平台: platform, 微信内: inWeChat }));
    return new Response(null, { status: 204 });
  }
  if (context.waitUntil) context.waitUntil(phCapture(env, "邀请落地页访问", visitorId, { 码: code, 平台: platform, 微信内: inWeChat, 邀请人有名: !!name }));

  // 奖励数字按访问时刻现价（与文章分享页 CTA 同源）：读不到 → 通用文案。
  let rate = null, cfg = null;
  try { const o = await env.FILES.get("config/mint-rate.json"); if (o) rate = JSON.parse(await o.text()); } catch {}
  try { const o = await env.FILES.get("config/referral.json"); if (o) cfg = JSON.parse(await o.text()); } catch {}
  // 面额读不到退默认（与 agent 的 REFERRAL_DEFAULTS 同值；functions 不 import agent 代码）。
  if (!cfg) cfg = { enabled: true, authorCoins: 9, newUserCoins: 9 };

  const origin = fwdHost ? `https://${fwdHost}` : new URL(request.url).origin;
  const pageUrl = fwdHost ? `${origin}/i/${code}` : request.url;
  const title = name ? `${name} 邀请你用 VoiceDrop` : "邀请你用 VoiceDrop";
  // 分享卡片图 = App logo（绝对 URL，微信爬虫认 og:image / image_src；反代域和
  // 直连域路径不同：voicedrop.cn/* → pages /voicedrop/*）。
  const logo = fwdHost ? `${origin}/icon-512.png` : `${origin}/voicedrop/icon-512.png`;
  const og = { description: "动动嘴，就能写出好文章。说一段话，VoiceDrop 用你的语气整理成一篇能发的文章。", url: pageUrl, image: logo };

  return new Response(invitePageHtml({ name, title, og, rate, cfg, code }), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

// 金色奖励条文案（cfg.enabled=false 或读不到 rate → 退化，绝不编数字）。
export function rewardCopy(name, rate, cfg) {
  const who = name ? `你和${name}` : "你们双方";
  const on = cfg && cfg.enabled !== false;
  if (!on) return "";
  const per = rate && rate.suanliPerCoin > 0 ? rate.suanliPerCoin : 0;
  if (!per) return `用这个链接下载，${who}都能得算力奖励`;
  const friend = Math.round(cfg.newUserCoins * per);
  const inviter = Math.round(cfg.authorCoins * per);
  const arts = Math.floor(friend / SUANLI_PER_ARTICLE);
  const artNote = arts >= 1 ? `（约可成文 ${arts} 篇）` : "";
  if (friend === inviter) return `用这个链接下载，${who}<b>各得 ${friend} 算力</b>${artNote}`;
  return `用这个链接下载，你得 <b>${friend} 算力</b>${artNote}，${name || "对方"}得 <b>${inviter} 算力</b>`;
}

export function invitePageHtml({ name, title, og, rate, cfg, code = "" }) {
  const avatar = esc((name || "朋").slice(0, 1));
  const inviterHtml = name
    ? `<b>${esc(name)}</b> 邀请你一起用`
    : `你的朋友邀请你一起用`;
  const reward = rewardCopy(esc(name), rate, cfg);
  const rewardBar = reward ? `
  <div class="reward">
    <svg width="20" height="20" viewBox="0 0 16 16" fill="#E2B871"><path d="M9 1L3 9h4l-1 6 7-8H8l1-6z"/></svg>
    <div>${reward}</div>
  </div>` : "";
  const note = name ? `已自动记住${esc(name)}的邀请 · 安装后打开即绑定` : "已自动记住这次邀请 · 安装后打开即绑定";

  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${esc(title)}</title>
${metaTags(title, og)}
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0}
body{background:#211F1B;color:#fff;min-height:100dvh;display:flex;flex-direction:column;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",Roboto,sans-serif;
  -webkit-text-size-adjust:100%}
.main{flex:1;background:linear-gradient(180deg,#2A2521 0%,#211F1B 100%);max-width:560px;width:100%;margin:0 auto}
.inviter{padding:26px 24px 0;display:flex;align-items:center;gap:10px}
.inviter .ava{width:34px;height:34px;border-radius:50%;background:#D8A25B;color:#fff;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.inviter .who{font-size:14px;color:#D7CDBD}
.inviter .who b{color:#fff}
.hero{padding:26px 24px 18px}
.hero h1{font-size:34px;font-weight:700;line-height:1.25;letter-spacing:.5px}
.hero p{font-size:15px;color:#C9BFAE;line-height:1.75;margin-top:14px}
.reward{margin:0 24px;background:rgba(226,184,113,.14);border:1px solid rgba(226,184,113,.3);border-radius:12px;padding:13px 15px;display:flex;align-items:center;gap:10px;font-size:13.5px;color:#F0E4CE;line-height:1.5}
.reward svg{flex:none}
.reward b{color:#E2B871}
.points{padding:22px 24px 40px;display:flex;flex-direction:column;gap:16px}
.pt{display:flex;gap:12px;align-items:flex-start}
.pt .ic{width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.08);flex:none;display:flex;align-items:center;justify-content:center}
.pt h3{font-size:15px;font-weight:600}
.pt p{font-size:13px;color:#A79E8E;margin-top:2px;line-height:1.5}
.dock{position:sticky;bottom:0;max-width:560px;width:100%;margin:0 auto;padding:12px 20px calc(18px + env(safe-area-inset-bottom));background:#211F1B;border-top:1px solid rgba(255,255,255,.08)}
.btns{display:flex;gap:9px}
.btn{flex:1;background:#fff;border-radius:11px;padding:11px 0;display:flex;align-items:center;justify-content:center;gap:7px;text-decoration:none;transition:opacity .2s}
.btn .t{text-align:left}
.btn .s{font-size:9px;color:#666;line-height:1}
.btn .n{font-size:14px;font-weight:600;color:#000;line-height:1.2}
.btn.dim{opacity:.55}
.note{text-align:center;font-size:11.5px;color:#7d766b;margin-top:9px}
</style></head>
<body>
<div class="main">
  <div class="inviter"><div class="ava">${avatar}</div><div class="who">${inviterHtml}</div></div>
  <div class="hero">
    <h1>动动嘴，<br>就能写出好文章</h1>
    <p>说一段话，VoiceDrop 用你的语气整理成一篇能发的文章。通勤路上、散步时，随口就写完了。</p>
  </div>${rewardBar}
  <div class="points">
    <div class="pt"><div class="ic"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#E2B871" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M5 9.5a5 5 0 0010 0M10 14.5V17.5"/></svg></div><div><h3>开口即写</h3><p>不用打字，说完自动成文</p></div></div>
    <div class="pt"><div class="ic"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#E2B871" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3l3.5 3.5L7 16.5l-4.2 1 1-4.2L13.5 3z"/></svg></div><div><h3>是你的语气</h3><p>学你的写作风格，越用越像</p></div></div>
    <div class="pt"><div class="ic"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#E2B871" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2L9 11M18 2l-6 16-3-7-7-3 16-6z"/></svg></div><div><h3>一键发布</h3><p>直接推到公众号草稿箱</p></div></div>
  </div>
</div>
<div class="dock">
  <div class="btns">
    <a class="btn" id="dl-ios" href="${APP_STORE}"><svg width="18" height="18" viewBox="0 0 20 20" fill="#000"><path d="M13.6 10.6c0-2 1.6-2.9 1.7-3-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6s1.5.6 2.5.6 1.7-1 2.3-2c.7-1.1 1-2.2 1-2.2s-1.7-.7-1.7-2.6zM11.8 4.6c.5-.7.9-1.6.8-2.6-.8 0-1.8.6-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1z"/></svg><div class="t"><div class="s">下载于</div><div class="n">App Store</div></div></a>
    <a class="btn" id="dl-android" href="${ANDROID_DL}"><svg width="17" height="17" viewBox="0 0 24 24" fill="#3DDC84"><path d="M17.6 9.5l1.5-2.7a.3.3 0 10-.5-.3l-1.6 2.7a9.6 9.6 0 00-8 0L7.4 6.5a.3.3 0 10-.5.3l1.5 2.7A9 9 0 003 17h18a9 9 0 00-3.4-7.5zM7.8 14.4a.9.9 0 110-1.8.9.9 0 010 1.8zm8.4 0a.9.9 0 110-1.8.9.9 0 010 1.8z"/></svg><div class="t"><div class="s">下载</div><div class="n">Android 版</div></div></a>
  </div>
  <div class="note">${note}</div>
</div>
<div id="wx-mask" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9;padding:26px 22px;text-align:right">
  <svg width="44" height="60" viewBox="0 0 44 60" fill="none" stroke="#E2B871" stroke-width="3" stroke-linecap="round" style="margin-right:8px"><path d="M22 54V10M22 10l-12 13M22 10l12 13"/></svg>
  <p style="font:600 19px/1.7 -apple-system,'PingFang SC';color:#fff;margin:14px 0 6px">微信里装不了 App</p>
  <p style="font:15px/1.7 -apple-system,'PingFang SC';color:#C9BFAE;margin:0">点右上角「···」，选「在浏览器打开」<br>再点下载就行。邀请已经记住了。</p>
</div>
<script>
// 归因三件套（都不挡渲染）：
// ① 第一方 beacon —— 浏览器直连 jianshuo.dev 报到（voicedrop.cn 反代会吃掉真实
//    IP，服务端只在这条请求上写 IP 指纹，见 /agent/referral/hit）；
// ② 下载点击写剪贴板（execCommand 先行——微信 webview 里 navigator.clipboard
//    常年不可用；再叠 clipboard API 双保险）；
// ③ 微信内点下载 → 不跳转，弹「去浏览器打开」蒙层（剪贴板照写）。
(function(){
  var HIT='https://jianshuo.dev/agent/referral/hit',CODE='${esc(code)}';
  try{(navigator.sendBeacon&&navigator.sendBeacon(HIT,CODE))||fetch(HIT,{method:'POST',body:CODE,mode:'no-cors',keepalive:true})}catch(e){}
  function keep(){
    try{var t=document.createElement('textarea');t.value=location.href;t.style.cssText='position:fixed;opacity:0';
      document.body.appendChild(t);t.select();t.setSelectionRange(0,99999);document.execCommand('copy');document.body.removeChild(t);}catch(e){}
    try{navigator.clipboard&&navigator.clipboard.writeText(location.href)}catch(e){}
    try{fetch(location.pathname+"?c=1",{keepalive:true})}catch(e){}
  }
  var ua=navigator.userAgent||'',wx=/MicroMessenger/i.test(ua);
  var mask=document.getElementById('wx-mask');
  function tap(e){keep();if(wx){e.preventDefault();mask.style.display='block';}}
  var i=document.getElementById('dl-ios'),a=document.getElementById('dl-android');
  i.addEventListener('click',tap);a.addEventListener('click',tap);
  mask.addEventListener('click',function(){mask.style.display='none';});
  if(/Android/i.test(ua))i.classList.add('dim');
  else if(/iPhone|iPad|iPod|Macintosh/i.test(ua))a.classList.add('dim');
})();
</script>
</body></html>`;
}

function notFound() {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>邀请不存在</title>
<style>body{background:#211F1B;color:#C9BFAE;font:16px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0}</style>
</head><body><p>这个邀请链接不存在或已失效。</p></body></html>`, {
    status: 404, headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
