import { expect, it } from 'vitest';
import { fakeD1, usageSql } from './fakes.js';
import { anonScopeFromToken } from '../../functions/lib/auth.js';
import { handleWechatPayRoute, runWechatPaySchedule, wechatV2Xml, parseWechatXml } from '../src/wechat-pay.js';

const NOW = Date.UTC(2026, 8, 23), TOKEN = 'anon_unittesttoken_abcdefghijklmnop';
async function setup() {
  const db = fakeD1(usageSql()), scope = await anonScopeFromToken(TOKEN), calls = [];
  const env = {USAGE:db, FILES:{get:async()=>({text:async()=>'{"enabled":true}'})},
    WECHAT_PAY_MCH_ID:'mch', WECHAT_PAY_APP_ID:'app', WECHAT_PAY_PLAN_ID:'plan',
    WECHAT_PAY_API_V2_KEY:'test-key', WECHAT_PAY_CALLBACK_BASE_URL:'https://example.test', WECHAT_PAY_AMOUNT_FEN:'1'};
  const fetcher = async (url, init) => {
    calls.push(url);
    expect(url).toBe('https://api.mch.weixin.qq.com/papay/preentrustweb');
    expect(parseWechatXml(init.body).appid).toBe('app');
    return new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:'app',mch_id:'mch',pre_entrustweb_id:'pre'},env.WECHAT_PAY_API_V2_KEY));
  };
  const call = (path, body) => {
    const url = new URL('https://example.test/agent/wechat-pay/'+path);
    return handleWechatPayRoute(url,new Request(url,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+TOKEN},body}),env,fetcher,NOW);
  };
  function legacy(status, subStatus='pending') {
    db.prepare("INSERT INTO wechat_sub(contract_code,user_sub,plan_id,status,created_at,updated_at) VALUES('legacy',?,'plan',?,?,?)").bind(scope,subStatus,NOW,NOW).run();
    db.prepare(`INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,payment_kind,created_at,updated_at)
      VALUES('app-order','legacy',?,'plan',?,?,1,?,'app',?,?)`).bind(scope,NOW,NOW+86400000,status,NOW,NOW).run();
  }
  return {db,env,calls,call,legacy,fetcher};
}

it('creates pure V2 authorization without any V3 credentials and exposes the configured price', async()=>{
  const f=await setup();
  const result=await f.call('contract','{}');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({pre_entrustweb_id:'pre'});
  expect((await (await f.call('status')).json()).amount_fen).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect((await f.call('checkout','{}')).status).toBe(404);
});

for(const status of ['pending','charging','settling']) it(`blocks a new V2 contract while a legacy APP order is ${status}`,async()=>{
  const f=await setup(); f.legacy(status);
  expect(await (await f.call('contract','{}')).json()).toEqual({error:'payment-pending'});
  expect((await (await f.call('status')).json()).payment_pending).toBe(true);
  expect(f.calls).toHaveLength(0);
  expect(f.db.prepare('SELECT status FROM wechat_txn').first().status).toBe(status);
});

it('never reuses a pending legacy APP agreement, even after payment',async()=>{
  const f=await setup(); f.legacy('paid');
  expect(await (await f.call('contract','{}')).json()).toEqual({error:'contract-status-unavailable'});
  expect(f.calls).toHaveLength(0);
});

it('retains paid legacy coverage when creating a new V2 agreement after cancellation',async()=>{
  const f=await setup(); f.legacy('paid','cancelled');
  f.db.exec(`UPDATE wechat_txn SET entitlement_end_at=${NOW+86400000}`);
  expect((await f.call('contract','{}')).status).toBe(200);
  expect((await (await f.call('status')).json()).expires_date).toBe(NOW+86400000);
  expect(f.db.prepare("SELECT status FROM wechat_txn WHERE out_trade_no='app-order'").first().status).toBe('paid');
});

it('does not query or settle legacy APP orders through V2',async()=>{
  const f=await setup(); f.legacy('charging');
  f.db.exec(`INSERT INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,next_query_at,created_at,updated_at)
    VALUES('app-order','app-order','legacy','cid','unknown',1,0,0,0)`);
  await runWechatPaySchedule(f.env,NOW,f.fetcher);
  const reply=await f.call('pay-notify',wechatV2Xml({appid:'app',mch_id:'mch',return_code:'SUCCESS',result_code:'SUCCESS',out_trade_no:'app-order',total_fee:1,contract_id:'cid',transaction_id:'wx'},f.env.WECHAT_PAY_API_V2_KEY));
  expect(parseWechatXml(await reply.text()).return_code).toBe('FAIL');
  expect(f.calls).toHaveLength(0);
  expect(f.db.prepare('SELECT COUNT(*) n FROM bucket').first().n).toBe(0);
});
