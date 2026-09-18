// WeChat monthly credits: public, self-contained product page.
const PRODUCT_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>微信包月算力 · VoiceDrop</title>
  <meta name="description" content="VoiceDrop 微信包月算力：19.9 元/月，每期 200 算力。了解录音转写与 AI 写作服务、自动续费时间、算力有效期和取消方式。">
  <link rel="canonical" href="https://voicedrop.cn/agent/wechat-pay/product">
  <meta property="og:type" content="website">
  <meta property="og:title" content="VoiceDrop 微信包月算力 · 19.9 元/月">
  <meta property="og:description" content="每期 200 算力，用于录音转写与 AI 写作。按月自动续费，可随时解除自动续费。">
  <meta property="og:url" content="https://voicedrop.cn/agent/wechat-pay/product">
  <meta name="theme-color" content="#faf6ef">
  <style>
    :root { color-scheme: light; --paper: #faf6ef; --card: #fffdf9; --ink: #2a2521; --muted: #6b5f51; --accent: #b9442c; --line: #e5dbcd; }
    * { box-sizing: border-box; }
    html { scroll-padding-top: 24px; }
    body { margin: 0; color: var(--ink); background: var(--paper); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.8; -webkit-font-smoothing: antialiased; }
    a { color: var(--accent); text-underline-offset: 4px; }
    a:hover { text-decoration-thickness: 2px; }
    a:focus-visible { outline: 3px solid var(--accent); outline-offset: 5px; border-radius: 3px; }
    .wrap { max-width: 1000px; margin: auto; padding: 0 32px; }
    .skip { position: absolute; top: -100px; left: 16px; background: white; padding: 8px 16px; z-index: 2; }
    .skip:focus { top: 12px; }
    header { border-bottom: 1px solid var(--line); }
    .nav { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-top: 20px; padding-bottom: 20px; }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-size: 19px; font-weight: 650; text-decoration: none; color: var(--ink); }
    .wave { display: inline-flex; align-items: center; gap: 3px; height: 26px; color: var(--accent); }
    .wave i { display: block; width: 3px; background: currentColor; border-radius: 2px; height: 12px; }
    .wave i:nth-child(2) { height: 20px; } .wave i:nth-child(3) { height: 26px; } .wave i:nth-child(4) { height: 17px; } .wave i:nth-child(5) { height: 8px; }
    .nav > a:last-child { color: var(--muted); font-size: 14px; }
    .hero { padding: 58px 0 36px; }
    .eyebrow { margin: 0 0 12px; color: var(--accent); font-size: 13px; font-weight: 650; letter-spacing: .1em; }
    h1 { font-family: "Songti SC", "Noto Serif CJK SC", "STSong", serif; font-size: clamp(34px, 6vw, 52px); font-weight: 600; line-height: 1.3; letter-spacing: -.03em; margin: 0 0 20px; }
    .intro { margin: 0; max-width: 640px; color: var(--muted); font-size: 17px; }
    .plan { display: grid; grid-template-columns: 1fr 1.25fr; margin-top: 32px; background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 3px 3px 14px 14px; }
    .price-block { padding: 28px 32px; }
    .price-label { margin: 0; font-size: 14px; color: var(--muted); }
    .price { margin: 4px 0; display: flex; align-items: baseline; gap: 4px; line-height: 1.3; }
    .currency { font-size: 25px; }
    .price strong { font-size: 62px; font-weight: 600; letter-spacing: -.06em; font-variant-numeric: tabular-nums; }
    .period { color: var(--muted); margin-left: 8px; }
    .price-note { margin: 12px 0 0; font-size: 13px; color: var(--muted); }
    .benefits { margin: 24px 0; padding: 0 32px; border-left: 1px solid var(--line); list-style: none; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
    .benefits li { padding-left: 17px; position: relative; }
    .benefits li::before { content: ""; width: 5px; height: 5px; background: var(--accent); border-radius: 50%; position: absolute; left: 0; top: 12px; }
    .jump { display: flex; flex-wrap: wrap; gap: 12px 25px; padding: 0 0 30px; border-bottom: 1px solid var(--line); font-size: 14px; }
    section.detail { display: grid; grid-template-columns: 195px minmax(0, 1fr); gap: 32px; padding: 34px 0; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 20px; line-height: 1.5; font-weight: 650; }
    h2 .num { display: block; font-size: 12px; color: var(--accent); letter-spacing: .12em; margin-bottom: 6px; }
    h3 { margin: 22px 0 6px; font-size: 16px; }
    h3:first-child { margin-top: 0; }
    p { margin: 0 0 12px; }
    p:last-child { margin-bottom: 0; }
    .body { color: var(--muted); font-size: 15px; }
    .body strong { color: var(--ink); }
    .body ul, .body ol { margin: 10px 0 0; padding-left: 22px; }
    .body li { margin-bottom: 8px; }
    .callout { margin: 18px 0; padding: 15px 18px; background: #f2e9dd; border-left: 3px solid #b7956d; border-radius: 0 6px 6px 0; }
    .steps { list-style: none; padding: 0 !important; counter-reset: step; }
    .steps li { position: relative; padding: 0 0 18px 40px; margin: 0; counter-increment: step; }
    .steps li::before { content: counter(step); position: absolute; left: 0; top: 1px; width: 26px; height: 26px; display: grid; place-items: center; background: #f2e9dd; color: var(--accent); border-radius: 50%; font-size: 13px; font-weight: 650; }
    .steps li:last-child { padding-bottom: 0; }
    .steps strong { display: block; margin-bottom: 3px; }
    footer { padding: 28px 0 40px; color: var(--muted); font-size: 12px; }
    footer p { margin-bottom: 7px; }
    footer a { color: inherit; }
    .email { overflow-wrap: anywhere; }
    @media (max-width: 640px) {
      .wrap { padding-left: 22px; padding-right: 22px; }
      .hero { padding-top: 36px; }
      .plan { grid-template-columns: 1fr; }
      .price-block { padding: 24px; }
      .benefits { margin: 0 24px; padding: 20px 0; border-left: 0; border-top: 1px solid var(--line); }
      section.detail { grid-template-columns: 1fr; gap: 16px; padding: 28px 0; }
      h2 .num { display: inline; margin-right: 10px; }
      .intro { font-size: 16px; }
    }
    @media print {
      body { background: white; }
      .wrap { max-width: none; padding: 0; }
      .jump, .skip { display: none; }
      .hero { padding-top: 24px; }
      section.detail { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#main">跳到正文</a>
  <header>
    <div class="wrap nav">
      <a class="brand" href="https://voicedrop.cn/"><span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>VoiceDrop</a>
      <a href="#support">联系与售后</a>
    </div>
  </header>
  <main class="wrap" id="main">
    <section class="hero" aria-labelledby="title">
      <p class="eyebrow">微信支付 · 按月自动续费</p>
      <h1 id="title">把想法说出来，<br>让算力接着写。</h1>
      <p class="intro">VoiceDrop 将口述录音转写为文字，并帮助你生成、修改和整理文章。微信包月算力为这些服务提供每月可用的算力额度。</p>
      <div class="plan" aria-label="包月套餐价格与权益">
        <div class="price-block">
          <p class="price-label">VoiceDrop 微信包月算力</p>
          <p class="price"><span class="currency">¥</span><strong>19.9</strong><span class="period">/ 月</span></p>
          <p class="price-note">人民币计价 · 首期与后续每期同价 · 无首期优惠</p>
        </div>
        <ul class="benefits">
          <li><strong>每期 200 算力</strong>，支付成功后到账</li>
          <li>用于录音转写、文章生成与 AI 编辑等服务</li>
          <li>按订阅周期到期，可随时解除自动续费</li>
        </ul>
      </div>
    </section>
    <nav class="jump" aria-label="本页目录">
      <a href="#credits">算力与有效期</a><a href="#billing">扣费时间</a><a href="#cancel">取消续费</a><a href="#support">开通与售后</a>
    </nav>
    <section class="detail" id="credits" aria-labelledby="credits-title">
      <h2 id="credits-title"><span class="num">01</span>算力与有效期</h2>
      <div class="body">
        <p>算力是 VoiceDrop 内的服务用量单位。录音转写、文章生成、AI 编辑等功能会按实际用量消耗算力；不同任务的消耗不同，<strong>200 算力不代表固定篇数或无限使用</strong>。余额及消耗记录可在 App 的「设置 → 算力」查看。</p>
        <p>每次成功支付 19.9 元，发放 200 算力。首次成功付款后，获得一个自然月的使用期；这里的一个月按订阅起始时间计算，<strong>不是每月月底统一清零，也不是固定 30 天</strong>。</p>
        <p>提前续费成功时，新一期的 200 算力会立即到账并可提前使用，有效至下一订阅周期结束。旧一期的剩余算力仍在原到期时间失效；未用完的额度不延期、不合并延长有效期。使用时优先消耗较早到期的算力。</p>
        <p>如果实际付款晚于约定的下一周期起点，新一期从实际付款时间起算一个自然月。具体到账和有效期以付款结果及 App 内记录为准。</p>
      </div>
    </section>
    <section class="detail" id="billing" aria-labelledby="billing-title">
      <h2 id="billing-title"><span class="num">02</span>如何签约与扣费</h2>
      <div class="body">
        <ol class="steps">
          <li><strong>首次开通：首期支付并签约</strong>在支持微信订阅的 Android 版 VoiceDrop 中进入「设置 → 算力」，选择微信支付订阅，并在微信中支付首期金额、确认自动续费协议。付款成功后发放首期算力，自动续费是否开通以签约结果为准。</li>
          <li><strong>每期续费：到期前三天申请</strong>后续扣款申请安排在当期到期日前第 3 个北京时间自然日凌晨 02:00。微信发送扣费前通知，通常在申请后 24 小时执行扣款，因此实际扣款可能早于当期到期日。</li>
          <li><strong>实际付款成功：发放当期算力</strong>以微信最终支付结果为准。首次或权益已到期后重新开通时由用户在微信确认付款；后续自动续费按通知后 24 小时扣费模式处理。扣款未成功时不会发放对应算力。</li>
        </ol>
        <div class="callout"><strong>提前扣费也会提前到账。</strong>续费支付成功后，新算力可以立即使用，旧算力的原到期日保持不变。请在计划扣款申请前解除自动续费，以避免下一次续费申请。</div>
        <h3>支付失败或仍在确认中</h3>
        <p>明确扣款失败后，同一周期最多自动尝试 3 次；下一次重试不会早于上一次尝试后的下一个北京时间自然日 02:00。支付结果尚未确定时，会先核实原订单结果。达到重试上限后停止该周期自动尝试，已付算力仍按原有效期使用。</p>
        <p>如果微信已扣款但算力暂未更新，请返回「算力」页刷新；仍有问题可联系下方客服，并提供微信支付订单号。</p>
      </div>
    </section>
    <section class="detail" id="cancel" aria-labelledby="cancel-title">
      <h2 id="cancel-title"><span class="num">03</span>取消与重新开通</h2>
      <div class="body">
        <h3>如何取消自动续费</h3>
        <p>在 VoiceDrop「设置 → 算力 → 包月算力」中点击<strong>「解除自动续费」</strong>并确认；也可以在微信的自动续费服务管理页面找到 VoiceDrop 并关闭服务。</p>
        <p>解约成功后不再发起新的续费扣款，已付算力继续有效至各自到期日。<strong>取消自动续费不会自动退款，也不会立即收回已付算力。</strong>卸载 App 不等于解除自动续费。</p>
        <p>若解约前已有扣款申请正在处理，该订单仍可能完成支付；成功支付后仍会发放对应算力，但不会恢复已解除的自动续费协议。如需处理这类订单，请联系客服。</p>
        <h3>重新开通</h3>
        <p>重新开通需要再次在微信中确认签约。若旧一期权益尚未到期，本次仅恢复自动续费授权，不重复购买当前周期，也不额外发放算力。下一期衔接原到期时间，扣款仍按到期前三天的计划申请。若已过计划时间，重新签约后会申请下一期扣款。若权益已到期，则通过首期支付并签约重新开通。旧订单结果未确认时，需先确认原支付结果后再开通。</p>
      </div>
    </section>
    <section class="detail" id="support" aria-labelledby="support-title">
      <h2 id="support-title"><span class="num">04</span>开通与售后</h2>
      <div class="body">
        <p>本页介绍 <strong>Android 版 VoiceDrop 的微信包月算力服务</strong>，是否可开通以 App 内入口开放情况为准。请在 App 内查看套餐并完成微信签约，本页不直接收款。已通过 Apple 订阅的用户，请在 Apple 订阅设置中管理原订阅。</p>
        <p>如有扣费、到账、解约或退款问题，请邮件联系 <a class="email" href="mailto:jianshuo@hotmail.com">jianshuo@hotmail.com</a>。请说明问题，并提供订单号、付款时间以及 App 中的账号标识，便于核实；无需提供支付密码或验证码。</p>
        <p>相关资料：<a href="https://voicedrop.cn/">VoiceDrop 产品首页</a> · <a href="https://voicedrop.cn/privacy/">隐私政策</a></p>
      </div>
    </section>
  </main>
  <footer class="wrap">
    <p>VoiceDrop · 微信包月算力产品说明</p>
    <p>更新日期：<time datetime="2026-09-15">2026 年 9 月 15 日</time></p>
    <p><a href="https://beian.miit.gov.cn/" rel="noopener noreferrer">沪ICP备06019413号-118</a></p>
  </footer>
</body>
</html>
`;

// Public product information for the WeChat merchant template. Keep this route
// independent of payment credentials, account state and storage availability.
export function handleWechatPayProductRoute(url, request) {
  if (url.pathname !== "/agent/wechat-pay/product" && url.pathname !== "/agent/wechat-pay/product/") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return new Response(request.method === "HEAD" ? null : PRODUCT_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
