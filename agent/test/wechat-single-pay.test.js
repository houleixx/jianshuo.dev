import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fakeD1, usageSql } from './fakes.js';
import { wechatV2Xml, parseWechatXml, verifyWechatV2 } from '../src/wechat-pay.js';
import { handleWechatSinglePayRoute } from '../src/wechat-single-pay.js';
const NOW=Date.UTC(2026,8,18,1), TOKEN='anon_single_payment_unittest_123456789';
const RID='2df542ef-9d2b-483e-a45a-215067888dfa';
const PREFIX='/agent/wechat-pay/single';
const SQL=usageSql()+'\n'+readFileSync(new URL('../migrations/0006_wechat_single.sql',import.meta.url),'utf8');
const env=()=>({USAGE:fakeD1(SQL),WECHAT_PAY_SINGLE_TEST_ENABLED:'true',WECHAT_PAY_APP_ID:'wx_unit_test',WECHAT_PAY_MCH_ID:'1900000001',WECHAT_PAY_API_V2_KEY:'unit-key',WECHAT_PAY_CALLBACK_BASE_URL:'https://test.example.com'});
function call(e,path,fetcher,{method='GET',token=TOKEN,body,now=NOW,ip='203.0.113.2'}={}) {
 const url=new URL('https://test.example.com'+PREFIX+path);
 return handleWechatSinglePayRoute(url,new Request(url,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(ip?{'cf-connecting-ip':ip}:{})},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}),e,fetcher,now);
}
const signed=(e,p)=>wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:e.WECHAT_PAY_APP_ID,mch_id:e.WECHAT_PAY_MCH_ID,...p},e.WECHAT_PAY_API_V2_KEY);
function provider(e,calls=[],extra={}) {return async(url,init)=>{const p=parseWechatXml(init.body);calls.push({url,p});expect(verifyWechatV2(p,e.WECHAT_PAY_API_V2_KEY)).toBe(true);return new Response(signed(e,url.endsWith('unifiedorder')?{trade_type:'APP',prepay_id:'wx_prepaid_test',...extra}:{out_trade_no:p.out_trade_no,trade_state:'NOTPAY',...extra}));};}
const create=(e,f,opts={})=>call(e,'/order',f,{method:'POST',body:{request_id:RID},...opts});
const notification=(e,id,extra={})=>signed(e,{out_trade_no:id,transaction_id:'4200001234567890123456789012',trade_type:'APP',total_fee:1,fee_type:'CNY',...extra});

describe('one-cent APP payment diagnostic',()=>{
 it('is disabled by default and requires authentication before calling WeChat',async()=>{
  const e=env();let calls=[];delete e.WECHAT_PAY_SINGLE_TEST_ENABLED;
  expect((await create(e,provider(e,calls))).status).toBe(404);
  e.WECHAT_PAY_SINGLE_TEST_ENABLED='true';
  expect((await create(e,provider(e,calls),{token:null})).status).toBe(401);expect(calls).toHaveLength(0);
 });
 it('submits fixed one-cent APP order and signs SDK parameters, without contract fields',async()=>{
  const e=env(),calls=[];const r=await create(e,provider(e,calls));expect(r.status).toBe(200);const b=await r.json();
  expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://api.mch.weixin.qq.com/pay/unifiedorder');
  expect(calls[0].p).toMatchObject({total_fee:'1',trade_type:'APP',notify_url:'https://test.example.com'+PREFIX+'/notify',spbill_create_ip:'203.0.113.2'});
  for(const key of ['plan_id','contract_code','contract_id','sp_mchid','sub_mchid','sub_appid'])expect(calls[0].p[key]).toBeUndefined();
  expect(b.order.status).toBe('pending');expect(b.order.amount_fen).toBe(1);expect(b.payment.package).toBe('Sign=WXPay');expect(verifyWechatV2(b.payment,e.WECHAT_PAY_API_V2_KEY)).toBe(true);
  expect(JSON.stringify(b)).not.toContain(e.WECHAT_PAY_API_V2_KEY);
 });
 it('rejects caller-controlled price and missing client IP',async()=>{
  const e=env(),calls=[];expect((await create(e,provider(e,calls),{body:{request_id:RID,total_fee:1990}})).status).toBe(400);
  expect((await create(e,provider(e,calls),{ip:null})).status).toBe(400);expect(calls).toHaveLength(0);
 });
 it('reuses a pending order across retries and different request IDs',async()=>{
  const e=env(),calls=[],f=provider(e,calls),first=await(await create(e,f)).json();
  const retry=await(await create(e,f,{body:{request_id:'3df542ef-9d2b-483e-a45a-215067888dfa'},now:NOW+1000})).json();
  expect(retry.order.out_trade_no).toBe(first.order.out_trade_no);expect(calls.filter(x=>x.url.endsWith('unifiedorder'))).toHaveLength(1);
 });
 it('does not create two remote orders on concurrent requests',async()=>{
  const e=env(),calls=[],f=provider(e,calls);await Promise.all([create(e,f),create(e,f,{body:{request_id:'3df542ef-9d2b-483e-a45a-215067888dfa'}})]);
  expect(calls.filter(x=>x.url.endsWith('unifiedorder'))).toHaveLength(1);
 });
 it('does not trust unsigned responses or treat a timeout as payment success',async()=>{
  const e=env();const b=await(await create(e,async()=>new Response('<xml><return_code>SUCCESS</return_code><result_code>SUCCESS</result_code><prepay_id>fake</prepay_id></xml>'))).json();
  expect(b.order.status).toBe('unknown');expect(b.payment).toBeUndefined();
  expect(b.order.last_error_code).toBe('WECHAT_RESPONSE_SIGNATURE_INVALID');
  const r=await(await create(e,async()=>{throw new Error('network timeout');})).json();expect(r.order.out_trade_no).toBe(b.order.out_trade_no);expect(r.order.status).not.toBe('paid');
 });
 it('returns a safe provider code for definite merchant permission failures',async()=>{
  const e=env();const r=await(await create(e,provider(e,[],{result_code:'FAIL',err_code:'NOAUTH'}))).json();expect(r.order.status).toBe('failed');expect(r.order.last_error_code).toBe('NOAUTH');expect(r.payment).toBeUndefined();
 });
 it('accepts signed payment notifications idempotently without granting subscriptions or credits',async()=>{
  const e=env(),b=await(await create(e,provider(e))).json(),id=b.order.out_trade_no;
  for(let n=0;n<2;n++)expect(await(await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,id)})).text()).toContain('SUCCESS');
  const s=await(await call(e,'/status',()=>{throw Error('paid orders should not query');})).json();expect(s.order.status).toBe('paid');expect(s.payment).toBeUndefined();
  for(const table of ['wechat_sub','wechat_txn','bucket','ledger'])expect((await e.USAGE.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n).toBe(0);
 });
 it('rejects forged, wrong-amount, wrong-merchant, wrong-app and non-APP notifications',async()=>{
  const e=env(),b=await(await create(e,provider(e))).json(),id=b.order.out_trade_no;
  for(const extra of [{total_fee:1990},{appid:'wrong'},{mch_id:'wrong'},{trade_type:'JSAPI'},{fee_type:'USD'},{transaction_id:''},{out_trade_no:'missing'}])expect(await(await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,id,extra)})).text()).toContain('FAIL');
  expect(await(await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,id).replace(/<sign>[\s\S]*?<\/sign>/,'<sign>forged</sign>')})).text()).toContain('FAIL');
  expect((await e.USAGE.prepare('SELECT status FROM wechat_single_order WHERE out_trade_no=?').bind(id).first()).status).toBe('pending');
 });
 it('confirms success by signed query when notification is missing, scoped to the owner',async()=>{
  const e=env(),b=await(await create(e,provider(e))).json();
  const f=provider(e,[],{trade_state:'SUCCESS',trade_type:'APP',total_fee:1,fee_type:'CNY',transaction_id:'4200001234567890123456789012'});
  const s=await(await call(e,'/status',f,{now:NOW+30000})).json();expect(s.order.status).toBe('paid');expect(s.order.confirmed_by).toBe('query');
  const other=await(await call(e,'/status',f,{token:'anon_other_single_payment_test_123456789'})).json();expect(other.order).toBeNull();
 });
 it('still receives existing order notifications after the test entry is disabled',async()=>{
  const e=env(),b=await(await create(e,provider(e))).json();delete e.WECHAT_PAY_SINGLE_TEST_ENABLED;
  expect(await(await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,b.order.out_trade_no)})).text()).toContain('SUCCESS');
 });
 it('does not regress confirmed payment or accept a different transaction ID',async()=>{
  const e=env(),b=await(await create(e,provider(e))).json(),id=b.order.out_trade_no;
  await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,id)});
  expect(await(await call(e,'/notify',null,{method:'POST',token:null,body:notification(e,id,{transaction_id:'4200009999999999999999999999'})})).text()).toContain('FAIL');
  expect((await(await call(e,'/status',provider(e))).json()).order.status).toBe('paid');
 });
});
