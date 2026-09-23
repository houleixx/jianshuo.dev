import { beforeAll, afterAll, it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';

// Exercise production crypto, IP parsing and fetch options in the deployed runtime.
let worker;
beforeAll(() => {
  const source = readFileSync(new URL('../src/wechat-v2.js', import.meta.url), 'utf8');
  worker = new Miniflare({
    modules: true, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    script: `import { isIP } from 'node:net';
` + source + `
export default { async fetch(request) {
  const config = {WECHAT_PAY_APP_ID:'app', WECHAT_PAY_MCH_ID:'mch', WECHAT_PAY_API_V2_KEY:'fixture-key'};
  try {
    const data = await wechatV2Request(config, '/pay/contractorder', {trade_type:'APP'}, async (url, init) => {
      const outgoing = new Request(url, init);
      if (outgoing.redirect !== 'manual') throw new Error('unsafe-redirect-mode');
      if (isIP('198.51.100.7') !== 4 || isIP('2001:db8::1') !== 6) throw new Error('invalid-ip');
      if (!verifyWechatV2(parseWechatXml(await outgoing.text()), config.WECHAT_PAY_API_V2_KEY))
        throw new Error('invalid-request-signature');
      const status = Number(new URL(request.url).pathname.slice(1)) || 200;
      if (status >= 300) return new Response('', {status, headers:{Location:'https://unexpected.example/'}});
      return new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',
        appid:'app',mch_id:'mch',prepay_id:'fixture'},config.WECHAT_PAY_API_V2_KEY));
    });
    return Response.json({ok:true,prepay_id:data.prepay_id});
  } catch(error) { return Response.json({ok:false,error:error.message}); }
}};`,
  });
});
afterAll(async () => { await worker?.dispose(); });
it('creates and verifies a V2 request in the Cloudflare runtime', async () => {
  expect(await (await worker.dispatchFetch('http://localhost/')).json()).toEqual({ok:true,prepay_id:'fixture'});
});
it.each([301,302,307,308])('rejects HTTP %i without forwarding signed payment data', async status => {
  expect(await (await worker.dispatchFetch('http://localhost/' + status)).json())
    .toEqual({ok:false,error:'unexpected-payment-redirect'});
});
