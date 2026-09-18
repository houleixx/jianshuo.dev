import {it,expect} from 'vitest';
import {generateKeyPairSync,sign,createCipheriv} from 'node:crypto';
import {fakeD1,usageSql} from './fakes.js';
import {handleWechatPayRoute,runWechatPaySchedule,wechatChargeScheduleAt,wechatV2Xml,parseWechatXml,verifyWechatV2} from '../src/wechat-pay.js';
const NOW=Date.UTC(2026,8,18,4), DAY=86400000;
const merchant=generateKeyPairSync('rsa',{modulusLength:2048}),platform=generateKeyPairSync('rsa',{modulusLength:2048});
const beijing=at=>new Date(at+8*3600000).toISOString().slice(0,19).replace('T',' ');
function fixture() {
 const db=fakeD1(usageSql()),requests=[];
 const env={USAGE:db,WECHAT_PAY_APP_ID:'app',WECHAT_PAY_MCH_ID:'mch',WECHAT_PAY_PLAN_ID:'223558',WECHAT_PAY_AMOUNT_FEN:'1',
 WECHAT_PAY_MCH_PRIVATE_KEY:merchant.privateKey.export({type:'pkcs8',format:'pem'}),WECHAT_PAY_MCH_SERIAL_NO:'serial',
 WECHAT_PAY_PUBLIC_KEY:platform.publicKey.export({type:'spki',format:'pem'}),WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_TEST',
 WECHAT_PAY_API_V3_KEY:'12345678901234567890123456789012',WECHAT_PAY_API_V2_KEY:'test-key',WECHAT_PAY_CALLBACK_BASE_URL:'https://example.test'};
 let at=NOW,orderState='ACCEPT',contractState='0',applyFails=false,cancelFails=false,onRequest=null;
 const first=()=>db.prepare("SELECT * FROM wechat_txn WHERE payment_kind='app' ORDER BY created_at DESC LIMIT 1").first();
 const sub=()=>db.prepare('SELECT * FROM wechat_sub ORDER BY created_at DESC LIMIT 1').first();
 const headers=raw=>({'Wechatpay-Timestamp':String(Math.floor(at/1000)),'Wechatpay-Nonce':'nonce','Wechatpay-Serial':env.WECHAT_PAY_PUBLIC_KEY_ID,
 'Wechatpay-Signature':sign('RSA-SHA256',Buffer.from(`${Math.floor(at/1000)}\nnonce\n${raw}\n`),platform.privateKey).toString('base64')});
 const json=data=>{const raw=JSON.stringify(data);return new Response(raw,{headers:headers(raw)});};
 const xml=data=>new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:'app',mch_id:'mch',...data},env.WECHAT_PAY_API_V2_KEY));
 const fetcher=async(url,init)=>{
  const p=init.body?.startsWith('<')?parseWechatXml(init.body):init.body?JSON.parse(init.body):{};
  requests.push({url,p}); if(onRequest)await onRequest(url,p);
  if(url.endsWith('/preentrustweb'))return xml({pre_entrustweb_id:'pre-id',miniprogram_username:'gh_test',miniprogram_path:'pages/index?pre_entrustweb_id=pre-id&sign_scene=app'});
  if(url.endsWith('/app-with-contract'))return json({prepay_id:'prepay-'+p.out_trade_no});
  if(url.endsWith('/querycontract')) {
   expect(p.contract_id || p.plan_id).toBeTruthy();
   const current=p.contract_id ? db.prepare('SELECT * FROM wechat_sub WHERE contract_id=?').bind(p.contract_id).first() : db.prepare('SELECT * FROM wechat_sub WHERE contract_code=?').bind(p.contract_code).first();
   return xml({contract_id:p.contract_id || 'cid-'+p.contract_code,plan_id:'223558',contract_code:current.contract_code,openid:'payer',
    contract_state:contractState,contract_signed_time:beijing(current.created_at),contract_terminated_time:beijing(at)});
  }
  if(url.endsWith('/deletecontract')) {if(cancelFails)throw new Error('timeout');contractState='1';return xml({contract_id:p.contract_id});}
  if(url.endsWith('/pappayapply')) {expect(p.plan_id).toBeUndefined();expect(verifyWechatV2(p,env.WECHAT_PAY_API_V2_KEY)).toBe(true);if(applyFails)throw new Error('timeout');return xml({});}
  if(url.endsWith('/orderquery')) {
   if(orderState==='ORDERNOTEXIST')return xml({result_code:'FAIL',err_code:'ORDERNOTEXIST'});
   return xml({...payment(p.out_trade_no),trade_state:orderState,trade_type:'PAP'});
  }
  if(url.includes('/v3/pay/transactions/out-trade-no/'))return json({appid:'app',mchid:'mch',out_trade_no:first().out_trade_no,trade_state:'NOTPAY'});
  throw new Error('Unexpected API '+url);
 };
 const call=async(path,body=null,h={})=>{
  const url=new URL('https://example.test/agent/wechat-pay/'+path);
  return handleWechatPayRoute(url,new Request(url,{method:body===null?'GET':'POST',headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop',...h},...(body===null?{}:{body})}),env,fetcher,at);
 };
 const notify=async(path,values)=>parseWechatXml(await(await call(path,wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',mch_id:'mch',...values},env.WECHAT_PAY_API_V2_KEY))).text());
 const contract=(change='ADD',extra={})=>notify(change==='DELETE'?'cancel-notify':'contract-notify',{
   contract_code:sub().contract_code,contract_id:'cid-'+sub().contract_code,plan_id:'223558',openid:'payer',change_type:change,operate_time:beijing(at),...extra});
 const payment=(no,extra={})=>({appid:'app',out_trade_no:no,contract_id:db.prepare('SELECT contract_id FROM wechat_attempt WHERE out_trade_no=?').bind(no).first()?.contract_id,
  total_fee:'1',fee_type:'CNY',time_end:beijing(at).replace(/[- :]/g,''),transaction_id:'wx-'+no,...extra});
 const pay=async()=>{
  const data={appid:'app',mchid:'mch',out_trade_no:first().out_trade_no,trade_type:'APP',trade_state:'SUCCESS',transaction_id:'wx-'+first().out_trade_no,
   amount:{total:1,currency:'CNY'},success_time:new Date(at).toISOString()};
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(env.WECHAT_PAY_API_V3_KEY),Buffer.from('123456789012'));cipher.setAAD(Buffer.from('transaction'));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const raw=JSON.stringify({event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',nonce:'123456789012',associated_data:'transaction',ciphertext}});
  expect((await call('app-pay-notify',raw,headers(raw))).status).toBe(204);
 };
 return {db,env,requests,first,sub,call,contract,pay,notify,payment,fetcher,xml,
  time:t=>at=t,query:s=>orderState=s,contractState:s=>contractState=s,failApply:v=>applyFails=v,failCancel:v=>cancelFails=v,onRequest:f=>onRequest=f,
  cron:()=>runWechatPaySchedule(env,at,fetcher),
  grants:()=>db.prepare("SELECT COUNT(*) n FROM ledger WHERE reason='subscription'").first().n,
  attempts:()=>db.prepare("SELECT a.* FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no WHERE t.payment_kind='deduct' ORDER BY a.attempt_no").all().results,
  async start(){expect((await call('checkout','{}')).status).toBe(200);await pay();expect((await contract()).return_code).toBe('SUCCESS');},
 };
}
it.each(['pay-first','sign-first'])('joins V3 payment and XML agreement in either order: %s',async order=>{
 const f=fixture();await f.call('checkout','{}');
 if(order==='pay-first'){await f.pay();expect(f.sub().next_charge_at).toBeNull();await f.contract();}
 else {await f.contract();expect(f.sub().next_charge_at).toBeNull();await f.cron();expect(f.attempts()).toHaveLength(0);await f.pay();}
 expect(f.sub().next_charge_at).toBe(wechatChargeScheduleAt(f.first().entitlement_end_at));
 await f.contract();await f.pay();expect(f.grants()).toBe(1);
});
it('queries missing signing callback using plan and merchant contract code',async()=>{
 const f=fixture();await f.call('checkout','{}');await f.pay();
 expect(f.sub().contract_id).toBeNull(); const status=await(await f.call('status')).json();
 expect(status.status).toBe('active');expect(status.can_cancel).toBe(true);expect(status.renewal_stopped).toBe(false);
 expect(f.requests.find(r=>r.url.endsWith('querycontract')).p).toMatchObject({plan_id:'223558',contract_code:f.sub().contract_code});
});
it('parallel schedules request one monthly debit, wait through ACCEPT, and settle once',async()=>{
 const f=fixture();await f.start();const boundary=f.first().entitlement_end_at;f.time(f.sub().next_charge_at);
 await Promise.all([f.cron(),f.cron()]);expect(f.attempts()).toHaveLength(1);expect(f.requests.filter(r=>r.url.endsWith('pappayapply'))).toHaveLength(1);
 const a=f.attempts()[0];f.time(a.created_at+DAY);await f.cron();expect(f.attempts()).toHaveLength(1);expect(f.grants()).toBe(1);
 const value=f.payment(a.out_trade_no);await Promise.all([f.notify('pay-notify',value),f.notify('pay-notify',value)]);
 expect(f.grants()).toBe(2);const t=f.db.prepare('SELECT * FROM wechat_txn WHERE out_trade_no=?').bind(a.cycle_no).first();
 expect(t.entitlement_start_at).toBe(boundary);expect(f.sub().next_charge_at).toBe(wechatChargeScheduleAt(t.entitlement_end_at));
 await f.cron();expect(f.attempts()).toHaveLength(1);
});
it('timeout never creates another debit; verified ORDERNOTEXIST resends same order',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);f.failApply(true);await f.cron();const a=f.attempts()[0];
 f.time(a.created_at+16*60000);await f.cron();expect(f.requests.filter(r=>r.url.endsWith('pappayapply'))).toHaveLength(1);
 f.query('ORDERNOTEXIST');f.failApply(false);f.time(a.created_at+32*60000);await f.cron();
 expect(f.requests.filter(r=>r.url.endsWith('pappayapply')).map(r=>r.p.out_trade_no)).toEqual([a.out_trade_no,a.out_trade_no]);expect(f.attempts()).toHaveLength(1);
});
it('known failures retry on later days with new orders, stop after three, and ignore stale failure callbacks',async()=>{
 const f=fixture();await f.start();const due=f.sub().next_charge_at;
 for(let i=0;i<3;i++) {
  f.time(due+i*DAY);await f.cron();const attempts=f.attempts();expect(attempts).toHaveLength(i+1);
  if(i) {await f.notify('pay-notify',f.payment(attempts[0].out_trade_no,{result_code:'FAIL',err_code:'FAIL'}));expect(f.attempts().at(-1).status).toBe('accepted');}
  await f.notify('pay-notify',f.payment(attempts.at(-1).out_trade_no,{result_code:'FAIL',err_code:'NOTENOUGH'}));
 }
 f.time(due+3*DAY);await f.cron();expect(f.attempts()).toHaveLength(3);expect(f.sub().next_charge_at).toBeNull();expect(f.sub().last_error_code).toBe('retry-exhausted');
 expect(new Set(f.attempts().map(a=>a.out_trade_no)).size).toBe(3);expect(new Set(f.attempts().map(a=>a.cycle_no)).size).toBe(1);
});
it('cancel timeout durably stops new debits; later query confirms cancellation and preserves coverage',async()=>{
 const f=fixture();await f.start();const end=f.first().entitlement_end_at;f.failCancel(true);
 expect((await f.call('cancel','{}')).status).toBe(502);expect(f.sub().cancel_requested_at).toBeTruthy();
 f.time(wechatChargeScheduleAt(end));await f.cron();expect(f.attempts()).toHaveLength(0);
 f.contractState('1');f.time(wechatChargeScheduleAt(end)+16*60000);await f.cron();
 expect(f.sub().status).toBe('cancelled');expect(f.grants()).toBe(1);expect(f.first().entitlement_end_at).toBe(end);
});
it.each([40])('cancel then reopen at day %i keeps prior paid coverage and allows one new V3 payment',async days=>{
 const f=fixture();await f.start();const end=f.first().entitlement_end_at;
 expect((await f.call('cancel','{}')).status).toBe(200);expect((await f.call('cancel','{}')).status).toBe(200);
 f.time(NOW+days*DAY);f.contractState('0');expect((await f.call('checkout','{}')).status).toBe(200);await f.pay();await f.contract();
 expect(f.first().entitlement_start_at).toBe(Math.max(end,NOW+days*DAY));expect(f.grants()).toBe(2);expect(f.sub().next_charge_at).not.toBeNull();
});
it('cancellation before ADD and payment preserves funds without reviving auto-renewal',async()=>{
 const f=fixture();await f.call('checkout','{}');await f.contract('DELETE');await f.contract();await f.pay();
 expect(f.sub().status).toBe('cancelled');expect(f.sub().next_charge_at).toBeNull();expect(f.grants()).toBe(1);
});
it('accepted debit may settle after cancellation but never schedules another debit',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();const a=f.attempts()[0];
 await f.call('cancel','{}');expect((await f.call('checkout','{}')).status).toBe(409);
 f.time(a.created_at+DAY);expect((await f.notify('pay-notify',f.payment(a.out_trade_no))).return_code).toBe('SUCCESS');
 expect(f.grants()).toBe(2);expect(f.sub().status).toBe('cancelled');expect(f.sub().next_charge_at).toBeNull();
});
it('remote cancellation and query errors both prevent a due debit',async()=>{
 for(const mode of ['cancelled','unknown']) {
  const f=fixture();await f.start();f.time(f.sub().next_charge_at);
  if(mode==='cancelled')f.contractState('1');else f.onRequest(url=>{if(url.endsWith('querycontract'))throw new Error('timeout');});
  await f.cron();expect(f.attempts()).toHaveLength(0);
 }
});
it('rejects signed wrong payer, merchant, amount, contract and timestamps',async()=>{
 const f=fixture();await f.start();expect((await f.contract('DELETE',{openid:'wrong'})).return_code).toBe('FAIL');
 f.time(f.sub().next_charge_at);await f.cron();const a=f.attempts()[0];
 for(const extra of [{mch_id:'other'},{appid:'other'},{total_fee:'2'},{contract_id:'other'},{time_end:'20260230120000'}])
  expect((await f.notify('pay-notify',f.payment(a.out_trade_no,extra))).return_code).toBe('FAIL');
 expect(f.grants()).toBe(1);expect(f.sub().status).toBe('active');
});
it('XML parser verifies escaped values and rejects ambiguous or malformed documents',()=>{
 const xml=wechatV2Xml({body:'a & < b ]]> c',nonce_str:'nonce',optional:undefined},'key');expect(verifyWechatV2(parseWechatXml(xml),'key')).toBe(true);
 for(const bad of ['<xml><a>1</a><a>2</a></xml>','<xml><a>1</a><bad></xml>','<!DOCTYPE xml><xml><a>1</a></xml>','<xml><x>&evil;</x></xml>'])expect(parseWechatXml(bad)).toBeNull();
});
it('payment arriving before apply response stays paid and cannot be overwritten as accepted',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);
 f.onRequest(async(url,p)=>{if(url.endsWith('pappayapply'))expect((await f.notify('pay-notify',f.payment(p.out_trade_no))).return_code).toBe('SUCCESS');});
 await f.cron();expect(f.attempts()[0].status).toBe('paid');expect(f.grants()).toBe(2);
});
it('failed settlement transaction rolls back credit, balance and order, then retries safely',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();const a=f.attempts()[0];
 const before=f.db.prepare('SELECT balance_uy,granted_uy FROM account').first();
 f.db.exec("CREATE TRIGGER abort_settle BEFORE UPDATE OF period_start_at ON wechat_sub BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.notify('pay-notify',f.payment(a.out_trade_no))).return_code).toBe('FAIL');
 expect(f.grants()).toBe(1);expect(f.db.prepare('SELECT balance_uy,granted_uy FROM account').first()).toEqual(before);expect(f.attempts()[0].status).toBe('accepted');
 f.db.exec('DROP TRIGGER abort_settle');expect((await f.notify('pay-notify',f.payment(a.out_trade_no))).return_code).toBe('SUCCESS');expect(f.grants()).toBe(2);
});
it('late renewal payment starts a full month at actual payment time and the next cycle is still renewable',async()=>{
 const f=fixture();await f.start();const boundary=f.first().entitlement_end_at;f.time(boundary+DAY);await f.cron();const a=f.attempts()[0];
 f.time(boundary+2*DAY);f.query('SUCCESS');await f.cron();expect(f.grants()).toBe(2);
 const t=f.db.prepare('SELECT * FROM wechat_txn WHERE out_trade_no=?').bind(a.cycle_no).first();expect(t.entitlement_start_at).toBe(boundary+2*DAY);
 f.time(f.sub().next_charge_at);f.query('ACCEPT');await f.cron();expect(f.attempts()).toHaveLength(2);
});
it('environment sale price changes do not silently increase an existing subscription charge',async()=>{
 const f=fixture();await f.start();f.env.WECHAT_PAY_AMOUNT_FEN='1990';f.time(f.sub().next_charge_at);await f.cron();
 expect(f.requests.find(r=>r.url.endsWith('pappayapply')).p.total_fee).toBe('1');
});
it('a refunded unresolved order blocks automatic renewal and replacement purchase',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();const a=f.attempts()[0];
 f.time(a.created_at+DAY);f.query('REFUND');await f.cron();expect(f.attempts()[0].status).toBe('refunded');
 await f.call('cancel','{}');expect((await f.call('checkout','{}')).status).toBe(409);expect(f.grants()).toBe(1);
});
it('cancellation while a missing-order recovery checks the contract prevents resending',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);f.failApply(true);await f.cron();const a=f.attempts()[0];
 f.time(a.created_at+16*60000);f.query('ORDERNOTEXIST');let cancelled=false;
 f.onRequest(async url=>{if(!cancelled && url.endsWith('querycontract')){cancelled=true;await f.contract('DELETE');}});
 await f.cron();expect(f.requests.filter(r=>r.url.endsWith('pappayapply'))).toHaveLength(1);expect(f.sub().status).toBe('cancelled');
});
it('later SUCCESS/REFUND-shaped callback cannot grant when trade_state is not SUCCESS',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();
 expect((await f.notify('pay-notify',f.payment(f.attempts()[0].out_trade_no,{trade_state:'REFUND'}))).return_code).toBe('FAIL');expect(f.grants()).toBe(1);
});
it('recovers renewal even after a scheduler outage longer than a month without creating catch-up charges',async()=>{
 const f=fixture();await f.start();f.time(NOW+90*DAY);await f.cron();const a=f.attempts()[0];expect(a).toBeTruthy();
 f.time(NOW+91*DAY);expect((await f.notify('pay-notify',f.payment(a.out_trade_no))).return_code).toBe('SUCCESS');
 await f.cron();expect(f.attempts()).toHaveLength(1);expect(f.grants()).toBe(2);
 expect(f.db.prepare('SELECT entitlement_start_at FROM wechat_txn WHERE out_trade_no=?').bind(a.cycle_no).first().entitlement_start_at).toBe(NOW+91*DAY);
});
it('delayed success after a verified refund does not grant refunded credit',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();const a=f.attempts()[0];
 f.time(a.created_at+DAY);f.query('REFUND');await f.cron();expect((await f.notify('pay-notify',f.payment(a.out_trade_no))).return_code).toBe('FAIL');expect(f.grants()).toBe(1);
});
it('unknown signing callback can be cancelled with the original merchant code',async()=>{
 const f=fixture();await f.call('checkout','{}');await f.pay();f.onRequest(url=>{if(url.endsWith('querycontract'))throw new Error('timeout');});
 expect((await f.call('cancel','{}')).status).toBe(200);
 expect(f.requests.find(r=>r.url.endsWith('deletecontract')).p).toMatchObject({plan_id:'223558',contract_code:f.sub().contract_code});
 expect(f.sub().status).toBe('cancelled');expect(f.grants()).toBe(1);
});

it('pagination renews every due user beyond the first page without duplicating pending orders',async()=>{
 const f=fixture();await f.start();const original=f.sub(), paid=f.first(),due=original.next_charge_at;
 for(let i=0;i<60;i++) {
  f.db.prepare(`INSERT INTO wechat_sub(contract_code,contract_id,user_sub,plan_id,status,sign_mode,period_start_at,period_end_at,next_charge_at,created_at,updated_at)
    VALUES(?,?,?,'223558','active','app',?,?,?,?,?)`).bind('extra'+i,'id'+i,'user'+i,paid.entitlement_start_at,paid.entitlement_end_at,due,NOW,NOW).run();
  f.db.prepare(`INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,payment_kind,paid_at,entitlement_start_at,entitlement_end_at,created_at,updated_at)
    VALUES(?,?,?,'223558',?,?,1,'paid','app',?,?,?,?,?)`).bind('paid'+i,'extra'+i,'user'+i,paid.period_start_at,paid.period_end_at,NOW,paid.entitlement_start_at,paid.entitlement_end_at,NOW,NOW).run();
 }
 f.time(due);await f.cron();expect(f.attempts()).toHaveLength(61);await f.cron();
 expect(f.requests.filter(r=>r.url.endsWith('pappayapply'))).toHaveLength(61);
});

it('new customers are not reported as paused renewals and existing customers see their agreed price',async()=>{
 const f=fixture();expect((await(await f.call('status')).json()).renewal_stopped).toBe(false);
 await f.start();f.env.WECHAT_PAY_AMOUNT_FEN='1990';expect((await(await f.call('status')).json()).amount_fen).toBe(1);
 await f.call('cancel','{}');expect((await(await f.call('status')).json()).amount_fen).toBe(1990);
});

it('unexpired reactivation restores authorization without another checkout, payment or credit; next cycle renews once',async()=>{
 const f=fixture();await f.start();const original=f.first(),end=original.entitlement_end_at;
 await f.call('cancel','{}');f.time(NOW+10*DAY);f.contractState('9');
 expect((await(await f.call('status')).json()).restore_authorization).toBe(true);
 const body=await(await f.call('checkout','{"restore_only":true}')).json();
 expect(body.checkout_mode).toBe('restore-authorization');expect(body.pay_params).toBeUndefined();
 expect(body.wechat_mini_program_path).toBe('pages/index?pre_entrustweb_id=pre-id&sign_scene=app');
 const code=f.sub().contract_code;
 await f.call('checkout','{"restore_only":true}');expect(f.sub().contract_code).toBe(code);
 expect(f.requests.filter(r=>r.url.endsWith('app-with-contract'))).toHaveLength(1);
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
 f.contractState('0');await f.contract();await f.contract();await f.cron();
 expect(f.grants()).toBe(1);expect(f.sub().period_end_at).toBe(end);expect(f.attempts()).toHaveLength(0);
 expect(f.sub().next_charge_at).toBe(wechatChargeScheduleAt(end));
 f.env.WECHAT_PAY_AMOUNT_FEN='1990';f.time(f.sub().next_charge_at);await f.cron();
 expect(f.attempts()).toHaveLength(1);const a=f.attempts()[0];
 expect(f.requests.filter(r=>r.url.endsWith('pappayapply'))[0].p.total_fee).toBe('1');
 f.time(a.created_at+DAY);await f.notify('pay-notify',f.payment(a.out_trade_no));
 expect(f.grants()).toBe(2);expect(f.sub().period_start_at).toBe(end);
});
it('restore-only intent never becomes a paid checkout after coverage expires',async()=>{
 const f=fixture();await f.start();await f.call('cancel','{}');f.time(NOW+40*DAY);
 const response=await f.call('checkout','{"restore_only":true}');expect(response.status).toBe(409);
 expect((await response.json()).error).toBe('coverage-changed');expect(f.requests.filter(r=>r.url.endsWith('app-with-contract'))).toHaveLength(1);
});
it('failed pure signing cannot silently fall back to APP payment, and cancellation stays terminal',async()=>{
 const f=fixture();await f.start();await f.call('cancel','{}');f.time(NOW+DAY);f.contractState('9');
 f.onRequest(url=>{if(url.endsWith('preentrustweb'))throw new Error('timeout');});
 expect((await f.call('checkout','{}')).status).toBe(502);
 expect(f.requests.filter(r=>r.url.endsWith('app-with-contract'))).toHaveLength(1);
 await f.call('cancel','{}');await f.contract();
 expect(f.sub().status).toBe('cancelled');expect(f.sub().next_charge_at).toBeNull();expect(f.grants()).toBe(1);
});
it('lost pure signing callback is recovered without charging an already-paid period',async()=>{
 const f=fixture();await f.start();await f.call('cancel','{}');f.time(NOW+DAY);f.contractState('9');
 await f.call('checkout','{}');f.contractState('0');await f.cron();
 expect(f.sub().status).toBe('active');expect(f.sub().next_charge_at).not.toBeNull();expect(f.grants()).toBe(1);expect(f.attempts()).toHaveLength(0);
});
it('re-signing after failed renewal can start one new attempt for the next unpaid cycle',async()=>{
 const f=fixture();await f.start();f.time(f.sub().next_charge_at);await f.cron();
 await f.notify('pay-notify',f.payment(f.attempts()[0].out_trade_no,{result_code:'FAIL',err_code:'NOTENOUGH'}));
 await f.call('cancel','{}');f.time(f.first().entitlement_end_at-DAY);f.contractState('9');
 await f.call('checkout','{}');f.contractState('0');await f.contract();await f.cron();await f.cron();
 expect(f.attempts()).toHaveLength(2);expect(new Set(f.attempts().map(a=>a.out_trade_no)).size).toBe(2);
 expect(f.grants()).toBe(1);
});

it('parallel pure-sign requests share one agreement and cannot turn into a payment order',async()=>{
 const f=fixture();await f.start();await f.call('cancel','{}');f.time(NOW+DAY);f.contractState('9');
 const responses=await Promise.all([f.call('checkout','{}'),f.call('checkout','{}')]);
 const bodies=await Promise.all(responses.map(r=>r.json()));
 expect(bodies.map(b=>b.checkout_mode)).toEqual(['restore-authorization','restore-authorization']);
 expect(bodies[0].contract_code).toBe(bodies[1].contract_code);
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_sub').first().n).toBe(2);
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});
it('signing after the carried paid period expires still deducts only the next cycle and grants a full paid month',async()=>{
 const f=fixture();await f.start();const end=f.first().entitlement_end_at;
 await f.call('cancel','{}');f.time(end-60000);f.contractState('9');await f.call('checkout','{}');
 f.time(end+60000);f.contractState('0');await f.contract();await f.cron();
 expect(f.attempts()).toHaveLength(1);const a=f.attempts()[0];
 await f.notify('pay-notify',f.payment(a.out_trade_no));
 expect(f.grants()).toBe(2);expect(f.sub().period_start_at).toBe(end+60000);
 expect(f.requests.filter(r=>r.url.endsWith('app-with-contract'))).toHaveLength(1);
});
it('pre-sign response must be signed and contain unmodified mini-program parameters',async()=>{
 const f=fixture();await f.start();await f.call('cancel','{}');f.time(NOW+DAY);f.contractState('9');
 const url=new URL('https://example.test/agent/wechat-pay/checkout');
 for(const response of [new Response('<xml><return_code>SUCCESS</return_code></xml>'),f.xml({pre_entrustweb_id:'id'})]) {
  const result=await handleWechatPayRoute(url,new Request(url,{method:'POST',headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop'},body:'{}'}),f.env,async()=>response,NOW+DAY);
  expect(result.status).toBe(502);
 }
 expect(f.db.prepare('SELECT COUNT(*) n FROM wechat_txn').first().n).toBe(1);
});
