import { beforeAll, afterAll, it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Execute the production helper in Workerd: Node's fetch accepts redirect:error,
// but the deployed Cloudflare runtime rejects it before sending a request.
let worker;
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const source = readFileSync(new URL('../src/wechat-v3.js', import.meta.url), 'utf8');
  worker = new Miniflare({
    modules: true,
    compatibilityDate: '2026-06-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      PUBLIC: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    script: source + `
export default { async fetch(request, env) {
  const config = { WECHAT_PAY_MCH_PRIVATE_KEY:env.KEY, WECHAT_PAY_PUBLIC_KEY:env.PUBLIC,
    WECHAT_PAY_PUBLIC_KEY_ID:'key-id', WECHAT_PAY_MCH_SERIAL_NO:'serial', WECHAT_PAY_MCH_ID:'merchant' };
  try {
    const data = await wechatV3Request(config, 'POST', '/v3/pay/transactions/app-with-contract',
      {amount:{total:1}}, async (url, init) => {
        const outgoing = new Request(url, init);
        if (!outgoing.headers.get('User-Agent') || outgoing.headers.get('Accept') !== 'application/json'
          || outgoing.headers.get('Content-Type') !== 'application/json' || !outgoing.headers.get('Authorization'))
          throw new Error('missing-wechat-required-headers');
        if (outgoing.redirect !== 'manual') throw new Error('unsafe-redirect-mode');
        const status = Number(new URL(request.url).pathname.slice(1)) || 200;
        if (status >= 300) return new Response('', {status, headers:{Location:'https://unexpected.example/'}});
        const raw = JSON.stringify({prepay_id:'fixture'}), timestamp = String(Math.floor(Date.now()/1000)), nonce = 'fixture';
        return new Response(raw, {headers:{'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':nonce,
          'Wechatpay-Serial':'key-id', 'Wechatpay-Signature':rsaSign(config, timestamp+'\\n'+nonce+'\\n'+raw+'\\n')}});
      });
    return Response.json({ok:true, ...data});
  } catch(error) { return Response.json({ok:false,error:error.message}); }
}};`,
  });
});
afterAll(async () => { await worker?.dispose(); });
it('creates and verifies a V3 request in the Cloudflare runtime', async () => {
  const result = await (await worker.dispatchFetch('http://localhost/')).json();
  expect(result).toEqual({ok:true,prepay_id:'fixture'});
});
it.each([301,302,307,308])('rejects HTTP %i without forwarding merchant authorization', async status => {
  const result = await (await worker.dispatchFetch('http://localhost/' + status)).json();
  expect(result).toEqual({ok:false,error:'unexpected-v3-redirect'});
});
