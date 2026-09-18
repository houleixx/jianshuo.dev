import { expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify, createCipheriv } from 'node:crypto';
import { wechatV3Request, wechatV3AppPayParams, decryptWechatV3Notification, verifyWechatV3, wechatV3Ready } from '../src/wechat-v3.js';
import { handleWechatPayRoute, runWechatPaySchedule } from '../src/wechat-pay.js';
import { fakeD1, usageSql } from './fakes.js';
const NOW = Date.UTC(2026, 8, 18, 4);
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  WECHAT_PAY_APP_ID:'app', WECHAT_PAY_MCH_ID:'mch', WECHAT_PAY_PLAN_ID:'223558', WECHAT_PAY_AMOUNT_FEN:'1',
  WECHAT_PAY_MCH_PRIVATE_KEY:merchant.privateKey.export({type:'pkcs8',format:'pem'}), WECHAT_PAY_MCH_SERIAL_NO:'MERCHANT_SERIAL',
  WECHAT_PAY_PUBLIC_KEY:platform.publicKey.export({type:'spki',format:'pem'}), WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_TEST',
  WECHAT_PAY_API_V3_KEY:'12345678901234567890123456789012',
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
function notification(data,at=NOW,eventType='TRANSACTION.SUCCESS') {
  const nonce='123456789012', aad='transaction';
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(credentials.WECHAT_PAY_API_V3_KEY),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const raw=JSON.stringify({event_type:eventType,resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext}});
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
  async function pay(extra={},time=NOW) {const n=notification(paid(extra),time);return call('app-pay-notify',n.raw,n.headers,time);}
  return {env,db,requests,txn,paid,call,pay,fetcher,setState:v=>state=v,failCreate:()=>failCreate=true,
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
it('paid but unsigned order gives coverage without claiming auto-renewal or accepting another payment',async()=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  const status=await (await f.call('status')).json();
  expect(status.active).toBe(true); expect(status.status).toBe('pending');expect(status.can_cancel).toBe(false);
  expect(status.checkout_paid).toBe(true);expect(status.checkout_pending).toBe(false);
  expect(status.scheduled_charge_at).toBeNull(); expect(status.renewal_available).toBe(false);
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
it('keeps unknown first payments out of automatic deduction retries',async()=>{
  const f=fixture();f.failCreate();expect((await f.call('checkout','{}')).status).toBe(502);
  await runWechatPaySchedule(f.env,NOW+1000,f.fetcher);
  expect(f.requests.every(r=>r.url.includes('/v3/'))).toBe(true);
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

async function agreement(f, state, time=NOW, overrides={}) {
  const sub=f.db.prepare('SELECT * FROM wechat_sub ORDER BY created_at DESC LIMIT 1').first();
  const data={mchid:'mch',appid:'app',plan_id:223558,out_contract_code:sub.contract_code,
    contract_id:'wx-agreement-'+sub.contract_code,contract_state:state,
    contract_signed_time:new Date(sub.created_at).toISOString(),
    ...(state==='TERMINATED'?{contract_terminate_info:{contract_terminated_time:new Date(time).toISOString(),contract_termination_mode:'USER_TERMINATE'}}:{}),
    ...overrides};
  const n=notification(data,time,state==='TERMINATED'?'ENTRUST.TERMINATE':'ENTRUST.SIGN');
  return f.call(state==='TERMINATED'?'cancel-notify':'contract-notify',n.raw,n.headers,time);
}
it('V3 signed agreement does not grant credit and duplicate sign/terminate notifications are idempotent',async()=>{
  const f=fixture();await f.call('checkout','{}');
  for(let i=0;i<3;i++)expect((await agreement(f,'SIGNED')).status).toBe(204);
  expect(f.grants()).toBe(0);
  expect(f.db.prepare('SELECT status FROM wechat_sub').first().status).toBe('active');
  await f.pay(); const end=f.txn().entitlement_end_at;
  for(let i=0;i<3;i++)expect((await agreement(f,'TERMINATED',NOW+1000)).status).toBe(204);
  const status=await(await f.call('status',null,{},NOW+2000)).json();
  expect(status.status).toBe('cancelled');expect(status.contract_status_known).toBe(true);
  expect(status.active).toBe(true);expect(status.expires_date).toBe(end);expect(f.grants()).toBe(1);
});
it('termination before payment and a delayed sign never revive a cancelled agreement',async()=>{
  const f=fixture();await f.call('checkout','{}');
  expect((await agreement(f,'TERMINATED',NOW+1000)).status).toBe(204);
  expect((await agreement(f,'SIGNED',NOW+2000)).status).toBe(204);
  await f.pay({},NOW+3000);
  expect(f.db.prepare('SELECT status FROM wechat_sub').first().status).toBe('cancelled');
  expect(f.grants()).toBe(1);
  expect((await(await f.call('status',null,{},NOW+4000)).json()).active).toBe(true);
});
it.each([{mchid:'wrong'},{appid:'wrong'},{plan_id:1},{out_contract_code:'unknown'},
  {contract_signed_time:'invalid'},{contract_signed_time:new Date(NOW+3600000).toISOString()}])
('rejects mismatched authenticated agreement %j without changing state',async extra=>{
  const f=fixture();await f.call('checkout','{}');
  expect((await agreement(f,'SIGNED',NOW,extra)).status).not.toBe(204);
  expect(f.db.prepare('SELECT status FROM wechat_sub').first().status).toBe('pending');
  expect(f.grants()).toBe(0);
});
it('agreement callback cannot be used as a payment notification',async()=>{
  const f=fixture();await f.call('checkout','{}');
  const n=notification(f.paid(),NOW,'ENTRUST.SIGN');
  expect((await f.call('app-pay-notify',n.raw,n.headers)).status).toBe(400);
  expect(f.grants()).toBe(0);
});
it('cancelled but unresolved payment blocks creating a second agreement',async()=>{
  const f=fixture();await f.call('checkout','{}');await agreement(f,'TERMINATED',NOW+1000);
  expect((await f.call('checkout','{}',{},NOW+2000)).status).toBe(409);
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_sub').first().n).toBe(1);
});
it.each([40])('reopening after cancellation at day %i preserves coverage and grants one full new month',async day=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  const oldEnd=f.txn().entitlement_end_at;
  await agreement(f,'TERMINATED',NOW+1000);
  const time=NOW+day*86400000;
  expect((await f.call('checkout','{}',{},time)).status).toBe(200);
  expect(f.txn().period_start_at).toBe(Math.max(oldEnd,time));
  expect((await f.pay({transaction_id:'wx-second',success_time:new Date(time).toISOString()},time)).status).toBe(204);
  expect(f.txn().entitlement_start_at).toBe(Math.max(oldEnd,time));
  expect(f.grants()).toBe(2);
  expect(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE reason='subscription'").first().n).toBe(2);
});
it('expiry alone never implies an unknown agreement was terminated',async()=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  const result=await f.call('checkout','{}',{},NOW+40*86400000);
  expect(result.status).toBe(409);expect((await result.json()).error).toBe('contract-status-unavailable');
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_sub').first().n).toBe(1);
});

it('expired replacement checkout releases only a verified closed order',async()=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  await agreement(f,'TERMINATED',NOW+1000);
  const time=NOW+40*86400000;
  expect((await f.call('checkout','{}',{},time)).status).toBe(200);
  const abandoned=f.txn().out_trade_no;
  expect(f.txn().period_start_at).toBe(time);
  await f.call('status',null,{},time+31*60000);
  expect(f.txn().status).toBe('failed');
  expect((await f.call('checkout','{}',{},time+32*60000)).status).toBe(200);
  expect(f.txn().out_trade_no).not.toBe(abandoned);
  expect(f.txn().period_start_at).toBe(time+32*60000);
  expect(f.db.prepare("SELECT COUNT(*) n FROM wechat_txn WHERE status='charging'").first().n).toBe(1);
  expect(f.grants()).toBe(1);
});
it('unexpired cancellation cannot charge another month when pure signing credentials are absent',async()=>{
  const f=fixture();await f.call('checkout','{}');await f.pay();
  await agreement(f,'TERMINATED',NOW+1000);
  expect((await f.call('checkout','{}',{},NOW+10*86400000)).status).toBe(503);
  expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
  expect(f.grants()).toBe(1);
});
it('unsigned closure cannot release the unresolved order or its cycle',async()=>{
  const f=fixture();await f.call('checkout','{}');
  const url=new URL('https://example.test/agent/wechat-pay/status');
  await handleWechatPayRoute(url,new Request(url,{headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop'}}),
    f.env,async()=>new Response(JSON.stringify({...f.paid(),trade_state:'CLOSED'})),NOW+31*60000);
  expect(f.txn().status).toBe('charging');
  expect(f.db.prepare('SELECT status FROM wechat_attempt').first().status).toBe('accepted');
});
