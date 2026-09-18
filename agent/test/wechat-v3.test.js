import { expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify, createCipheriv } from 'node:crypto';
import { wechatV3Request, wechatV3AppPayParams, decryptWechatV3Notification, verifyWechatV3, wechatV3Ready } from '../src/wechat-v3.js';
import { handleWechatPayRoute, wechatV2Xml, runWechatPaySchedule } from '../src/wechat-pay.js';
import { fakeD1, usageSql } from './fakes.js';
const NOW = Date.UTC(2026, 8, 18, 4);
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  WECHAT_PAY_APP_ID:'app', WECHAT_PAY_MCH_ID:'mch', WECHAT_PAY_PLAN_ID:'223558', WECHAT_PAY_AMOUNT_FEN:'1',
  WECHAT_PAY_MCH_PRIVATE_KEY:merchant.privateKey.export({type:'pkcs8',format:'pem'}), WECHAT_PAY_MCH_SERIAL_NO:'MERCHANT_SERIAL',
  WECHAT_PAY_PUBLIC_KEY:platform.publicKey.export({type:'spki',format:'pem'}), WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_TEST',
  WECHAT_PAY_API_V3_KEY:'12345678901234567890123456789012', WECHAT_PAY_API_V2_KEY:'v2-test-only',
  WECHAT_PAY_CALLBACK_BASE_URL:'https://example.test',
};
function headers(raw, at=NOW) {
  const timestamp = String(Math.floor(at/1000)), nonce='notification-nonce';
  return new Headers({'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':nonce,'Wechatpay-Serial':credentials.WECHAT_PAY_PUBLIC_KEY_ID,
    'Wechatpay-Signature':sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),platform.privateKey).toString('base64')});
}
function response(data,at=NOW,status=200) {
  const raw = status === 204 ? '' : JSON.stringify(data);
  return new Response(status===204?null:raw,{status,headers:headers(raw,at)});
}
function notification(data,at=NOW) {
  const nonce='123456789012', aad='transaction';
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(credentials.WECHAT_PAY_API_V3_KEY),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const raw=JSON.stringify({event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext}});
  return {raw,headers:headers(raw,at)};
}
function fixture() {
  const db=fakeD1(usageSql()), requests=[];
  const env={...credentials,USAGE:db,FILES:{get:async()=>({text:async()=>'{"enabled":true}'})}};
  let state='NOTPAY', at=NOW, failCreate=false;
  const txn=()=>db.prepare("SELECT * FROM wechat_txn ORDER BY created_at DESC LIMIT 1").first();
  const paid=(extra={})=>({appid:'app',mchid:'mch',out_trade_no:txn().out_trade_no,trade_type:'APP',trade_state:'SUCCESS',transaction_id:'wx-paid',amount:{total:1,currency:'CNY'},success_time:new Date(NOW).toISOString(),...extra});
  const fetcher=async(url,init)=>{
    requests.push({url,init});
    if(url.endsWith('/app-with-contract')) {
      if(failCreate){ failCreate=false; throw new Error('timeout'); }
      return response({prepay_id:'prepay-test'},at);
    }
    if(url.endsWith('/close')) { state='CLOSED'; return response({},at,204); }
    if(url.includes('/v3/pay/transactions/out-trade-no/') && state === 'ORDER_NOT_EXIST') return response({code:state},at,404);
    if(url.includes('/v3/pay/transactions/out-trade-no/')) return response({...paid(),trade_state:state},at);
    throw new Error('unexpected API '+url);
  };
  async function call(path,body=null,customHeaders={},time=NOW) {
    at=time;
    const url=new URL('https://example.test/agent/wechat-pay/'+path);
    const jobs=[];
    const r=await handleWechatPayRoute(url,new Request(url,{method:body===null?'GET':'POST',headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop',...Object.fromEntries(new Headers(customHeaders))},...(body===null?{}:{body})}),env,fetcher,time,{waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs); return r;
  }
  async function signing(c,time=NOW) {return call('contract-notify',wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',mch_id:'mch',appid:'app',change_type:'ADD',contract_code:c,contract_id:'contract-id',plan_id:'223558',openid:'payer'},env.WECHAT_PAY_API_V2_KEY),{},time);}
  async function pay(extra={},time=NOW) {const n=notification(paid(extra),time);return call('app-pay-notify',n.raw,n.headers,time);}
  return {env,db,requests,txn,paid,call,signing,pay,fetcher,setState:v=>state=v,failCreate:()=>failCreate=true,
    grants:()=>db.prepare("SELECT COUNT(*) n FROM bucket WHERE source='subscription'").first().n};
}
it('signs exact V3 HTTP and APP SDK messages with merchant RSA key',async()=>{
  await wechatV3Request(credentials,'POST','/v3/pay/transactions/app-with-contract',{amount:{total:1}},async(url,init)=>{
    const a=Object.fromEntries([...init.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(m=>[m[1],m[2]]));
    const text=`POST\n/v3/pay/transactions/app-with-contract\n${a.timestamp}\n${a.nonce_str}\n${init.body}\n`;
    expect(verify('RSA-SHA256',Buffer.from(text),merchant.publicKey,Buffer.from(a.signature,'base64'))).toBe(true);
    expect(a.serial_no).toBe('MERCHANT_SERIAL');
    return response({prepay_id:'prepay'});
  },NOW);
  const p=wechatV3AppPayParams(credentials,'prepay',NOW);
  expect(verify('RSA-SHA256',Buffer.from(`app\n${p.timeStamp}\n${p.nonceStr}\nprepay\n`),merchant.publicKey,Buffer.from(p.sign,'base64'))).toBe(true);
  expect(p.packageValue).toBe('Sign=WXPay');
});
it('rejects unsigned success, altered body, old timestamp, wrong key ID and bad AES key',async()=>{
  await expect(wechatV3Request(credentials,'GET','/v3/test',null,async()=>new Response('{}'),NOW)).rejects.toThrow('signature');
  const n=notification({amount:{total:1}});
  expect(decryptWechatV3Notification(credentials,n.headers,n.raw,NOW).amount.total).toBe(1);
  expect(verifyWechatV3(credentials,n.headers,n.raw+' ',NOW)).toBe(false);
  expect(verifyWechatV3(credentials,n.headers,n.raw,NOW+301000)).toBe(false);
  n.headers.set('Wechatpay-Serial','wrong');
  expect(()=>decryptWechatV3Notification(credentials,n.headers,n.raw,NOW)).toThrow();
  expect(wechatV3Ready({...credentials,WECHAT_PAY_API_V3_KEY:'bad'})).toBe(false);
});
it('creates correct one-cent APP-with-contract request and resumes only that merchant order',async()=>{
  const f=fixture(), first=await (await f.call('checkout','{}')).json();
  expect(first.pay_params.prepayId).toBe('prepay-test');
  const payload=JSON.parse(f.requests[0].init.body);
  expect(payload.amount).toEqual({total:1,currency:'CNY'});
  expect(payload.contract_info.plan_id).toBe('223558');
  expect(payload.contract_info.contract_appid).toBe(payload.appid);
  expect(payload.notify_url).toBe('https://example.test/agent/wechat-pay/app-pay-notify');
  expect(payload.contract_info.contract_notify_url).toBe('https://example.test/agent/wechat-pay/contract-notify');
  expect(Object.keys(payload).sort()).toEqual(['appid','mchid','description','out_trade_no','time_expire','notify_url','amount','contract_info'].sort());
  const again=await (await f.call('checkout','{}',{},NOW+1000)).json();
  expect(again.pay_params.prepayId).toBe(first.pay_params.prepayId);
  expect(f.requests.filter(r=>r.url.endsWith('app-with-contract'))).toHaveLength(1);
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});
for(const paymentFirst of [true,false]) it(`settles once with paymentFirst=${paymentFirst} and never issues a second first debit`,async()=>{
  const f=fixture(), c=(await (await f.call('checkout','{}')).json()).contract_code;
  if(paymentFirst) expect((await f.pay()).status).toBe(204);
  await f.signing(c,NOW+1000);
  if(!paymentFirst) expect((await f.pay({},NOW+1000)).status).toBe(204);
  expect((await f.pay({},NOW+2000)).status).toBe(204);
  await f.signing(c,NOW+2000);
  expect(f.grants()).toBe(1);
  const sub=f.db.prepare('SELECT * FROM wechat_sub').first();
  expect(sub.status).toBe('active'); expect(sub.period_start_at).not.toBeNull();
  expect(sub.next_charge_at).toBeGreaterThan(NOW+20*86400000);
  await runWechatPaySchedule(f.env,NOW+3000,f.fetcher);
  expect(f.requests.some(r=>r.url.includes('pappayapply'))).toBe(false);
  expect((await f.call('checkout','{}',{},NOW+4000)).status).toBe(409);
});
it('paid but unsigned order gives coverage without claiming auto-renewal or accepting another payment',async()=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  const status=await (await f.call('status')).json();
  expect(status.active).toBe(true); expect(status.status).toBe('pending');expect(status.can_cancel).toBe(false);
  expect(status.checkout_paid).toBe(true);expect(status.checkout_pending).toBe(false);
  expect(f.db.prepare('SELECT next_charge_at FROM wechat_sub').first().next_charge_at).toBeNull();
  expect((await f.call('checkout','{}')).status).toBe(409);
});
it.each([{amount:{total:2,currency:'CNY'}},{appid:'other'},{mchid:'other'},{trade_type:'JSAPI'}])('rejects authenticated mismatched payment %j',async extra=>{
  const f=fixture(); await f.call('checkout','{}');
  expect((await f.pay(extra)).status).not.toBe(204);expect(f.grants()).toBe(0);
});
it('recovers a lost callback by signed V3 query',async()=>{
  const f=fixture();await f.call('checkout','{}');f.setState('SUCCESS');
  expect((await (await f.call('status',null,{},NOW+1000)).json()).active).toBe(true);
  expect(f.grants()).toBe(1);await f.pay({},NOW+2000);expect(f.grants()).toBe(1);
});
it('keeps unknown first payments out of automatic V2 deduction retries',async()=>{
  const f=fixture();f.failCreate();expect((await f.call('checkout','{}')).status).toBe(502);
  await runWechatPaySchedule(f.env,NOW+1000,f.fetcher);
  expect(f.requests.some(r=>r.url.includes('pappayapply'))).toBe(false);
  expect(f.grants()).toBe(0);
});
it('closes expired unpaid checkout before allowing a new order',async()=>{
  const f=fixture();await f.call('checkout','{}');const old=f.txn().out_trade_no;
  expect((await f.call('checkout','{}',{},NOW+31*60000)).status).toBe(409);
  expect(f.txn().status).toBe('failed');
  expect((await f.call('checkout','{}',{},NOW+32*60000)).status).toBe(200);
  expect(f.txn().out_trade_no).not.toBe(old); expect(f.grants()).toBe(0);
});

it('retries the same order after creation timeout and local expiry without creating a second charge',async()=>{
  const f=fixture();f.failCreate();await f.call('checkout','{}');const original=f.txn().out_trade_no;
  f.setState('ORDER_NOT_EXIST');
  expect((await f.call('checkout','{}',{},NOW+31*60000)).status).toBe(200);
  expect(f.txn().out_trade_no).toBe(original);
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});
it('a concurrent retry cannot create two first orders',async()=>{
  const f=fixture(); const results=await Promise.all([f.call('checkout','{}'),f.call('checkout','{}')]);
  expect(results.map(r=>r.status)).toEqual([200,200]);
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
  const orders=f.requests.filter(r=>r.url.endsWith('app-with-contract')).map(r=>JSON.parse(r.init.body).out_trade_no);
  expect(new Set(orders).size).toBe(1);
});
