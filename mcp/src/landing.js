// 浏览器点开 voicedrop.cn/mcp 时看到的介绍页。
//
// MCP 客户端永远看不到它 —— http.js 按 Accept 分流：只有明确要 text/html 的
// 才走这里，其余一律回 405（规范要求 MCP 客户端的 GET 必带 text/event-stream）。
//
// 配色跟 voicedrop/index.html 一致：暖色深底 + 焦橙点缀 + 奶油色字。

const ACCENT = "#D8593B";
const BG = "#14110c";
const CARD = "#211C17";
const TEXT = "#F4ECDD";
const MUTED = "#A79C8B";

export function landingHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoiceDrop MCP</title>
<meta name="description" content="把 VoiceDrop 账号接进 Claude —— 读写文章、改文风、触发挖矿、逛社区、查算力、发公众号。">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:${BG};color:${TEXT};
    font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    padding:clamp(28px,7vw,72px) clamp(20px,6vw,24px);
    -webkit-font-smoothing:antialiased;
  }
  main{max-width:680px;margin:0 auto}
  .eyebrow{color:${ACCENT};font-weight:600;letter-spacing:.14em;font-size:12px;text-transform:uppercase}
  h1{font-size:clamp(30px,7vw,42px);line-height:1.2;margin:.35em 0 .5em;letter-spacing:-.02em}
  .lede{color:${MUTED};font-size:clamp(16px,4vw,18px);margin-bottom:2.4em}
  h2{font-size:15px;font-weight:600;letter-spacing:.06em;color:${ACCENT};margin:2.6em 0 .9em;text-transform:uppercase}
  code,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
  pre{
    background:${CARD};border:1px solid #35302a;border-radius:10px;
    padding:16px 18px;overflow-x:auto;font-size:13.5px;line-height:1.65;
  }
  pre code{color:${TEXT}}
  p code{background:${CARD};padding:.15em .45em;border-radius:5px;font-size:.9em;color:${TEXT}}
  .endpoint{
    display:block;background:${CARD};border:1px solid ${ACCENT}55;border-radius:10px;
    padding:14px 18px;font-family:ui-monospace,monospace;font-size:clamp(14px,3.6vw,16px);
    color:${ACCENT};word-break:break-all;
  }
  ul{list-style:none;display:grid;gap:10px}
  li{padding-left:1.1em;position:relative;color:${MUTED}}
  li::before{content:"▸";position:absolute;left:0;color:${ACCENT}}
  li b{color:${TEXT};font-weight:600}
  .note{border-left:2px solid ${ACCENT};padding:2px 0 2px 16px;color:${MUTED};margin:1.6em 0}
  footer{margin-top:3.5em;padding-top:1.6em;border-top:1px solid #2c2721;color:#6f665b;font-size:13px}
  a{color:${ACCENT};text-decoration:none;border-bottom:1px solid ${ACCENT}44}
  a:hover{border-bottom-color:${ACCENT}}
</style>
</head>
<body>
<main>
  <div class="eyebrow">Model Context Protocol</div>
  <h1>VoiceDrop MCP</h1>
  <p class="lede">
    把你的 VoiceDrop 账号接进 Claude。说完话，剩下的交给对话——
    读写文章、改文风、触发挖矿、逛社区、查算力、发公众号。
  </p>

  <h2>端点</h2>
  <code class="endpoint">https://voicedrop.cn/mcp</code>
  <p class="note">
    你现在看到的是这个地址的**介绍页**。它同时也是一个 MCP 端点——
    MCP 客户端用 POST 与它对话（无状态 streamable HTTP），拿到的是工具，不是网页。
  </p>

  <h2>接进 Claude Code</h2>
  <pre><code>claude mcp add voicedrop --transport http https://voicedrop.cn/mcp \\
  --header "Authorization: Bearer &lt;你的令牌&gt;"</code></pre>
  <p class="note">
    其它客户端（Claude 桌面版的自定义连接器等）：URL 填上面的地址，
    自定义头填 <code>Authorization: Bearer &lt;令牌&gt;</code>。
  </p>

  <h2>怎么拿令牌</h2>
  <ul>
    <li><b>在 App 里复制</b> —— 设置 → 账户 → 访问令牌。最快。</li>
    <li><b>用 <code>login</code> 工具</b> —— 手机配对登录，调两次：先报手机「设置 → 账户」里的 6 位码，
        手机随即弹出一个 4 位码，再把它报回来。<code>login</code> 是唯一免令牌的工具，
        所以没接上 MCP 也能先用它登录。</li>
  </ul>
  <p class="note">
    令牌是账号的完整密钥，<b style="color:${TEXT}">不可吊销、不会过期</b>。别贴到任何公开的地方。
  </p>

  <h2>能干什么</h2>
  <ul>
    <li><b>文章</b> —— 列出、读、改写；版本历史与撤销重做</li>
    <li><b>文风</b> —— 读写你的写作风格；攒语料，一键蒸馏成可执行的风格规则</li>
    <li><b>挖矿</b> —— 催一下把录音变成文章；用新风格重写旧文章</li>
    <li><b>社区</b> —— 看推荐流、读帖、分享自己的文章、给别人投币</li>
    <li><b>算力</b> —— 余额、流水、收支汇总（23 算力 = 1 元）</li>
    <li><b>发布</b> —— 公开分享链接、微信公众号草稿、小红书文案</li>
  </ul>
  <p class="note">
    工具的完整说明随 MCP 一起下发（<code>tools/list</code>），接上就能看见，这里不重复——
    免得两处文档各说各话。
  </p>

  <footer>
    VoiceDrop · <a href="https://voicedrop.cn/">首页</a>
  </footer>
</main>
</body>
</html>`;
}
