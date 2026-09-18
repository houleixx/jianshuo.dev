import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createCipheriv } from 'node:crypto';
import { fakeD1, usageSql } from './fakes.js';
import { handleWechatPayRoute, runWechatPaySchedule } from '../src/wechat-pay.js';
import { it } from 'vitest';
import { handleSubscriptionStatusRoute } from '../src/subscription-status.js';
it('preserves paid V3 orders and credit while retiring recurring transport and contract callbacks', async () => {
const now=Date.now();
const merchant=generateKeyPairSync('rsa',{modulusLength:2048});
const platform=generateKeyPairSync('rsa',{modulusLength:2048});
const db=fakeD1(usageSql());
const env={USAGE:db,WECHAT_PAY_APP_ID:'app',WECHAT_PAY_MCH_ID:'merchant',WECHAT_PAY_PLAN_ID:'plan',WECHAT_PAY_AMOUNT_FEN:'1',
WECHAT_PAY_API_V3_KEY:'12345678901234567890123456789012',WECHAT_PAY_MCH_SERIAL_NO:'serial',
WECHAT_PAY_MCH_PRIVATE_KEY:merchant.privateKey.export({type:'pkcs8',format:'pem'}),
WECHAT_PAY_PUBLIC_KEY:platform.publicKey.export({type:'spki',format:'pem'}),WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_TEST',
WECHAT_PAY_CALLBACK_BASE_URL:'https://example.test'};
const headers=raw=>{
 const timestamp=String(Math.floor(now/1000));
 return {'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':'nonce','Wechatpay-Serial':'PUB_KEY_ID_TEST',
 'Wechatpay-Signature':sign('RSA-SHA256',Buffer.from(`${timestamp}\nnonce\n${raw}\n`),platform.privateKey).toString('base64')};
};
let requests=0;
const fetcher=async(url,init)=>{
 requests++;
 assert.equal(url,'https://api.mch.weixin.qq.com/v3/pay/transactions/app-with-contract');
 assert.equal(JSON.parse(init.body).amount.total,1);
 const raw=JSON.stringify({prepay_id:'prepay'});return new Response(raw,{headers:headers(raw)});
};
const call=(path,body=null,h={})=>{
 const url=new URL('https://example.test/agent/wechat-pay/'+path);
 return handleWechatPayRoute(url,new Request(url,{method:body===null?'GET':'POST',headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop',...h},...(body===null?{}:{body})}),env,fetcher,now);
};
assert.equal((await call('checkout','{}')).status,200);
const txn=await db.prepare('SELECT * FROM wechat_txn').first();
function notification(amount=1){
 const cipher=createCipheriv('aes-256-gcm',Buffer.from(env.WECHAT_PAY_API_V3_KEY),Buffer.from('123456789012'));cipher.setAAD(Buffer.from('transaction'));
 const data={appid:'app',mchid:'merchant',out_trade_no:txn.out_trade_no,trade_type:'APP',trade_state:'SUCCESS',transaction_id:'paid',amount:{total:amount,currency:'CNY'},success_time:new Date(now).toISOString()};
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const raw=JSON.stringify({event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',nonce:'123456789012',associated_data:'transaction',ciphertext}});
 return {raw,headers:headers(raw)};
}
let n=notification(2);assert.notEqual((await call('app-pay-notify',n.raw,n.headers)).status,204);
n=notification();assert.equal((await call('app-pay-notify',n.raw,{})).status,400);
for(let i=0;i<3;i++)assert.equal((await call('app-pay-notify',n.raw,n.headers)).status,204);
assert.equal((await db.prepare("SELECT COUNT(*) n FROM bucket WHERE source='subscription'").first()).n,1);
assert.equal((await db.prepare("SELECT COUNT(*) n FROM ledger WHERE reason='subscription'").first()).n,1);
assert.equal((await call('checkout','{}')).status,409);
const sharedUrl=new URL('https://example.test/agent/subscription/status');
const shared=await handleSubscriptionStatusRoute(sharedUrl,new Request(sharedUrl,{headers:{Authorization:'Bearer anon_unittesttoken_abcdefghijklmnop'}}),env,now);
assert.equal((await shared.json()).active,true,'verified paid coverage must protect all clients from duplicate subscriptions');
const before=await db.prepare('SELECT * FROM wechat_sub').first();
assert.equal((await call('cancel','{}')).status,501);
assert.deepEqual(await db.prepare('SELECT * FROM wechat_sub').first(),before);
const status=await(await call('status')).json();assert.equal(status.active,true);assert.equal(status.renewal_available,false);assert.equal(status.can_cancel,false);
for(const path of ['contract','contract-notify','cancel-notify','pay-notify'])assert.equal((await call(path,'<xml/>')).status,404);
await db.prepare("UPDATE wechat_sub SET status='active',contract_id='existing'").run();
await runWechatPaySchedule(env,now+40*86400000,fetcher);assert.equal(requests,1);
});
