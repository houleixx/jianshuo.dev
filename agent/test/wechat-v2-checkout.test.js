import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {wechatV2Request,wechatV2AppPayParams,wechatV2Ready,wechatV2Xml,parseWechatXml,verifyWechatV2,wechatPaymentTime} from '../src/wechat-v2.js';
import {handleWechatPayRoute,runWechatPaySchedule} from '../src/wechat-pay.js';
import {fakeD1,usageSql} from './fakes.js';
const NOW=Date.UTC(2026,8,23,4), TOKEN='anon_unittesttoken_abcdefghijklmnop';
const credentials={WECHAT_PAY_APP_ID:'app',WECHAT_PAY_MCH_ID:'mch',WECHAT_PAY_API_V2_KEY:'test-key',
  WECHAT_PAY_PLAN_ID:'223558',WECHAT_PAY_AMOUNT_FEN:'1',WECHAT_PAY_CALLBACK_BASE_URL:'https://example.test'};
const xml=(data,status=200)=>new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:'app',mch_id:'mch',...data},credentials.WECHAT_PAY_API_V2_KEY),{status});
function fixture(){
 const db=fakeD1(usageSql()),requests=[],env={...credentials,USAGE:db,FILES:{get:async()=>({text:async()=>'{"enabled":true}'})}};
 let at=NOW,state='NOTPAY',contractState='9',failCreate=false,intercept=null;
 const txn=()=>db.prepare("SELECT * FROM wechat_txn WHERE payment_kind='app' ORDER BY created_at DESC LIMIT 1").first();
 const sub=()=>db.prepare('SELECT * FROM wechat_sub ORDER BY created_at DESC LIMIT 1').first();
 const paid=(extra={})=>({out_trade_no:txn().out_trade_no,trade_type:'APP',trade_state:'SUCCESS',transaction_id:'wx-'+txn().out_trade_no,
   total_fee:1,fee_type:'CNY',time_end:wechatPaymentTime(at),...extra});
 const fetcher=async(url,init)=>{
  const p=parseWechatXml(init.body);requests.push({url,p,init});
  expect(verifyWechatV2(p,credentials.WECHAT_PAY_API_V2_KEY)).toBe(true);
  if(intercept){const response=await intercept(url,p);if(response)return response;}
  if(url.endsWith('/contractorder')){
   if(failCreate){failCreate=false;throw new Error('timeout');}
   return xml({trade_type:'APP',prepay_id:'prepay-'+p.out_trade_no,contract_result_code:'SUCCESS',out_trade_no:p.out_trade_no});
  }
  if(url.endsWith('/orderquery'))return state==='ORDERNOTEXIST'?xml({result_code:'FAIL',err_code:state}):xml({...paid(),trade_state:state});
  if(url.endsWith('/closeorder')){state='CLOSED';return xml({});}
  if(url.endsWith('/querycontract'))return xml({contract_id:'cid-'+sub().contract_code,contract_code:sub().contract_code,
    plan_id:'223558',contract_state:contractState,openid:'payer',contract_signed_time:new Date(sub().created_at+8*3600000).toISOString().slice(0,19).replace('T',' '),
    contract_terminated_time:new Date(at+8*3600000).toISOString().slice(0,19).replace('T',' ')});
  if(url.endsWith('/preentrustweb'))return xml({pre_entrustweb_id:'pre-id',miniprogram_username:'gh_test',miniprogram_path:'pages/sign?session=a%2Fb'});
  throw new Error('Unexpected API '+url);
 };
 const call=async(path,body=null,time=at,headers={})=>{
  at=time;const url=new URL('https://example.test/agent/wechat-pay/'+path);
  return handleWechatPayRoute(url,new Request(url,{method:body===null?'GET':'POST',headers:{Authorization:'Bearer '+TOKEN,'CF-Connecting-IP':'198.51.100.7',...headers},...(body===null?{}:{body})}),env,fetcher,at);
 };
 const notify=async(extra={},time=at)=>{
  at=time;const raw=await xml(paid(extra)).text();
  return parseWechatXml(await(await call('app-pay-notify',raw,time)).text());
 };
 return {db,env,requests,txn,sub,paid,call,notify,fetcher,state:v=>state=v,contractState:v=>contractState=v,
   failCreate:()=>failCreate=true,intercept:f=>intercept=f,grants:()=>db.prepare("SELECT COUNT(*) n FROM ledger WHERE reason='subscription'").first().n};
}

it('requires only V2 credentials and signs the exact APP SDK field names with MD5',()=>{
 expect(wechatV2Ready(credentials)).toBe(true);expect(wechatV2Ready({...credentials,WECHAT_PAY_API_V2_KEY:''})).toBe(false);
 const p=wechatV2AppPayParams(credentials,'prepay',NOW);
 const exact=`appid=app&noncestr=${p.nonceStr}&package=Sign=WXPay&partnerid=mch&prepayid=prepay&timestamp=${p.timeStamp}&key=test-key`;
 expect(p.sign).toBe(createHash('md5').update(exact).digest('hex').toUpperCase());
 expect(p.packageValue).toBe('Sign=WXPay');expect(p.sign).toMatch(/^[A-F0-9]{32}$/);
});

it('rejects unsigned, altered, wrong-merchant and redirected responses',async()=>{
 for(const response of [new Response('<xml><return_code>SUCCESS</return_code><result_code>SUCCESS</result_code></xml>'),
   xml({mch_id:'other'}),new Response((await xml({prepay_id:'p'}).text()).replace('<prepay_id>p<','<prepay_id>changed<'))]){
  await expect(wechatV2Request(credentials,'/pay/contractorder',{},async()=>response)).rejects.toThrow('signature');
 }
 await expect(wechatV2Request(credentials,'/pay/orderquery',{},async(url,init)=>{
  expect(init.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://other.test'}});
 })).rejects.toThrow('redirect');
 await expect(wechatV2Request(credentials,'https://other.test',{},async()=>xml({}))).rejects.toThrow('path');
});

it('only signed errors can prove an order does not exist',async()=>{
 await expect(wechatV2Request(credentials,'/pay/orderquery',{},async()=>xml({result_code:'FAIL',err_code:'ORDERNOTEXIST'})))
   .rejects.toMatchObject({code:'ORDERNOTEXIST',verified:true});
 await expect(wechatV2Request(credentials,'/pay/orderquery',{},async()=>new Response('<xml><return_code>SUCCESS</return_code><result_code>FAIL</result_code><err_code>ORDERNOTEXIST</err_code></xml>')))
   .rejects.toMatchObject({code:'unconfirmed',verified:false});
});

it('creates the V2 payment-and-contract request and resumes only its original order',async()=>{
 const f=fixture(),first=await(await f.call('checkout','{}')).json();
 expect(first.pay_params.prepayId).toBe('prepay-'+f.txn().out_trade_no);
 const p=f.requests[0].p;
 expect(p).toMatchObject({appid:'app',mch_id:'mch',contract_appid:'app',contract_mchid:'mch',total_fee:'1',fee_type:'CNY',
   trade_type:'APP',spbill_create_ip:'198.51.100.7',plan_id:'223558',time_expire:wechatPaymentTime(NOW+30*60000),
   notify_url:'https://example.test/agent/wechat-pay/app-pay-notify',contract_notify_url:'https://example.test/agent/wechat-pay/contract-notify'});
 const again=await(await f.call('checkout','{}',NOW+1000)).json();
 expect(again.pay_params.prepayId).toBe(first.pay_params.prepayId);
 expect(f.requests.filter(r=>r.url.endsWith('/contractorder'))).toHaveLength(1);
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});

it('paid but unsigned state grants once and does not claim a confirmed agreement',async()=>{
 const f=fixture();await f.call('checkout','{}');expect((await f.notify()).return_code).toBe('SUCCESS');await f.notify();
 const s=await(await f.call('status')).json();
 expect(s).toMatchObject({active:true,status:'pending',checkout_paid:true,checkout_pending:false,contract_status_known:false});
 expect(s.scheduled_charge_at).toBeNull();expect(f.grants()).toBe(1);
 expect((await f.call('checkout','{}')).status).toBe(409);
});

it.each([{total_fee:2},{appid:'other'},{mch_id:'other'},{trade_type:'JSAPI'},{fee_type:'USD'},
 {time_end:'20260230120000'},{trade_state:'REFUND'}])('rejects signed mismatched APP payment %j',async extra=>{
 const f=fixture();await f.call('checkout','{}');expect((await f.notify(extra)).return_code).toBe('FAIL');expect(f.grants()).toBe(0);
});

it('rejects unsigned or tampered payment notifications and ACKs XML only after settlement',async()=>{
 const f=fixture();await f.call('checkout','{}');
 const raw=await xml(f.paid()).text();
 const response=await f.call('app-pay-notify',raw.replace('<total_fee>1<','<total_fee>2<'));
 expect(parseWechatXml(await response.text()).return_code).toBe('FAIL');expect(f.grants()).toBe(0);
 expect((await f.notify()).return_code).toBe('SUCCESS');expect(f.grants()).toBe(1);
});

it('recovers a missing payment callback using a verified V2 query without duplicate grants',async()=>{
 const f=fixture();await f.call('checkout','{}');f.state('SUCCESS');
 expect((await(await f.call('status',null,NOW+1000)).json()).active).toBe(true);
 expect(f.grants()).toBe(1);await f.notify({},NOW+2000);expect(f.grants()).toBe(1);
});

it('creation timeout and expiry only retry the same merchant order',async()=>{
 const f=fixture();f.failCreate();expect((await f.call('checkout','{}')).status).toBe(502);const no=f.txn().out_trade_no;
 f.state('ORDERNOTEXIST');expect((await f.call('checkout','{}',NOW+31*60000)).status).toBe(200);
 expect(f.txn().out_trade_no).toBe(no);expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
 expect(f.requests.some(r=>r.url.endsWith('/pappayapply'))).toBe(false);
});

it('unsigned ORDERNOTEXIST cannot authorize resubmitting or replacing a checkout',async()=>{
 const f=fixture();f.failCreate();await f.call('checkout','{}');
 f.intercept(url=>url.endsWith('/orderquery')?new Response('<xml><return_code>SUCCESS</return_code><result_code>FAIL</result_code><err_code>ORDERNOTEXIST</err_code></xml>'):null);
 expect((await f.call('checkout','{}',NOW+31*60000)).status).toBe(502);
 expect(f.requests.filter(r=>r.url.endsWith('/contractorder'))).toHaveLength(1);
});

it('closure and verified agreement termination precede replacement checkout',async()=>{
 const f=fixture();await f.call('checkout','{}');const no=f.txn().out_trade_no;
 expect((await f.call('checkout','{}',NOW+31*60000)).status).toBe(409);expect(f.txn().status).toBe('failed');
 expect((await f.call('checkout','{}',NOW+32*60000)).status).toBe(409);
 f.contractState('1');expect((await f.call('checkout','{}',NOW+33*60000)).status).toBe(200);
 expect(f.txn().out_trade_no).not.toBe(no);expect(f.grants()).toBe(0);
});

it('unsigned closure never releases the order or grants credits',async()=>{
 const f=fixture();await f.call('checkout','{}');f.intercept(url=>url.endsWith('/orderquery')?new Response('<xml><return_code>SUCCESS</return_code><result_code>SUCCESS</result_code><trade_state>CLOSED</trade_state></xml>'):null);
 await f.call('status',null,NOW+31*60000);expect(f.txn().status).toBe('charging');expect(f.grants()).toBe(0);
});

it('concurrent requests share a single first order',async()=>{
 const f=fixture();const results=await Promise.all([f.call('checkout','{}'),f.call('checkout','{}')]);
 expect(results.map(r=>r.status)).toEqual([200,200]);
 expect(new Set(f.requests.filter(r=>r.url.endsWith('/contractorder')).map(r=>r.p.out_trade_no)).size).toBe(1);
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});

it('invalid pre-sign result never launches an ordinary payment as a silent fallback',async()=>{
 const f=fixture();f.intercept(url=>url.endsWith('/contractorder')?xml({trade_type:'APP',prepay_id:'p',contract_result_code:'FAIL'}):null);
 expect((await f.call('checkout','{}')).status).toBe(502);expect(f.grants()).toBe(0);
});

it('an absent client IP never submits invented merchant or device information',async()=>{
 const f=fixture();expect((await f.call('checkout','{}',NOW,{'CF-Connecting-IP':''})).status).toBe(502);
 expect(f.requests).toHaveLength(0);
});

it('scheduled recovery of an uncertain APP order never submits a PAP debit',async()=>{
 const f=fixture();f.failCreate();await f.call('checkout','{}');
 await runWechatPaySchedule(f.env,NOW+16*60000,f.fetcher);
 expect(f.requests.some(r=>r.url.endsWith('/pappayapply'))).toBe(false);expect(f.grants()).toBe(0);
});
