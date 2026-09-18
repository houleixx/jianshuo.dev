import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fakeD1, usageSql } from './fakes.js';

const migration = '0008_wechat_v3_cleanup.sql';
const cleanup = readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8');
const removed = {
  wechat_sub: ['openid', 'next_charge_at'],
  wechat_txn: ['charge_requested_at', 'processing_at', 'next_try_at', 'attempt_count', 'max_attempts', 'last_error_at'],
  wechat_attempt: ['resubmit_count'],
};
const retiredIndexes = ['idx_wechat_sub_due', 'idx_wechat_txn_due', 'idx_wechat_txn_settling'];
const tables = ['wechat_sub', 'wechat_txn', 'wechat_attempt', 'wechat_event', 'account', 'bucket', 'ledger'];
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().results;
const indexes = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' ORDER BY name").all().results;

function checkSchema(db) {
  for (const [table, fields] of Object.entries(removed)) {
    const names = db.prepare(`PRAGMA table_info(${table})`).all().results.map(c => c.name);
    for (const field of fields) expect(names).not.toContain(field);
  }
  for (const name of retiredIndexes) expect(indexes(db).map(i => i.name)).not.toContain(name);
  expect(db.prepare('PRAGMA integrity_check').first().integrity_check).toBe('ok');
}

it('builds the V3 schema from the full migration chain', () => {
  const db = fakeD1(usageSql());
  checkSchema(db);
  expect(db.prepare('PRAGMA table_info(wechat_txn)').all().results.map(c => c.name))
    .toEqual(expect.arrayContaining(['prepay_id', 'request_serial', 'payment_kind', 'entitlement_end_at']));
});

it('upgrades populated schemas without changing retained orders, audit history, balances or uniqueness', () => {
  const db = fakeD1(usageSql({ before: migration }));
  db.exec(`
    INSERT INTO wechat_sub(contract_code,contract_id,user_sub,plan_id,openid,status,period_start_at,period_end_at,next_charge_at,created_at,updated_at)
      VALUES('legacy','wx-contract','old-user','plan','old-openid','cancelled',100,200,180,100,150);
    INSERT INTO wechat_sub(contract_code,user_sub,plan_id,status,sign_mode,created_at,updated_at)
      VALUES('app','new-user','plan','pending','app',300,300);
    INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,wechat_txn_id,paid_at,entitlement_start_at,entitlement_end_at,charge_requested_at,processing_at,next_try_at,attempt_count,max_attempts,last_error_at,created_at,updated_at)
      VALUES('paid','legacy','old-user','plan',100,200,1,'paid','wx-paid',110,110,210,100,105,180,2,3,108,100,110);
    INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,payment_kind,prepay_id,checkout_expires_at,request_serial,created_at,updated_at)
      VALUES('pending','app','new-user','plan',300,400,1,'charging','app','prepay-test',350,'123456',300,300);
    INSERT INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,resubmit_count,next_query_at,created_at,updated_at)
      VALUES('paid','paid','legacy','wx-contract','paid',1,2,NULL,100,110),
            ('pending','pending','app','','accepted',1,0,320,300,300);
    INSERT INTO wechat_event(contract_code,out_trade_no,user_sub,direction,event_type,code,message,payload,created_at)
      VALUES('legacy','paid','old-user','inbound','payment_settled','SUCCESS','historic payment','{"amount":1}',110);
    INSERT INTO account(user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at)
      VALUES('old-user',150,200,50,100,120);
    INSERT INTO bucket(user_sub,amount_uy,remaining_uy,source,created_at,expires_at,wechat_order)
      VALUES('old-user',200,150,'subscription',110,210,'paid');
    INSERT INTO ledger(user_sub,ts,kind,amount_uy,reason,detail,balance_uy)
      VALUES('old-user',110,'grant',200,'subscription','{"provider":"wechat","out_trade_no":"paid"}',200);
  `);
  const expected = Object.fromEntries(tables.map(table => [table, rows(db, table).map(row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !(removed[table] || []).includes(key))))]));
  const expectedIndexes = indexes(db).filter(i => !retiredIndexes.includes(i.name));
  db.exec(cleanup);
  checkSchema(db);
  for (const table of tables) expect(rows(db, table)).toEqual(expected[table]);
  expect(indexes(db)).toEqual(expectedIndexes);
  expect(() => db.exec("UPDATE wechat_txn SET wechat_txn_id='wx-paid' WHERE out_trade_no='pending'"))
    .toThrow(/UNIQUE constraint/);
  expect(() => db.exec("INSERT INTO bucket(user_sub,amount_uy,remaining_uy,source,created_at,wechat_order) VALUES('old-user',200,200,'subscription',120,'paid')"))
    .toThrow(/UNIQUE constraint/);
  expect(() => db.exec("INSERT INTO ledger(user_sub,ts,kind,amount_uy,reason,detail,balance_uy) SELECT user_sub,ts,kind,amount_uy,reason,detail,balance_uy FROM ledger"))
    .toThrow(/UNIQUE constraint/);
  expect(() => db.exec("INSERT INTO wechat_sub(contract_code,user_sub,plan_id,status,created_at,updated_at) VALUES('duplicate','new-user','plan','pending',300,300)"))
    .toThrow(/UNIQUE constraint/);
  expect(() => db.exec("INSERT INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,created_at,updated_at) VALUES('duplicate','pending','app','','accepted',2,300,300)"))
    .toThrow(/UNIQUE constraint/);
});

it('adds independent contract verification without trusting historical rows or weakening live cycle uniqueness',()=>{
  const name='0009_wechat_contract_events.sql';
  const db=fakeD1(usageSql({before:name}));
  db.exec(`INSERT INTO wechat_sub(contract_code,user_sub,plan_id,status,created_at,updated_at)
    VALUES('old','u','p','active',100,100);
    INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,created_at,updated_at)
    VALUES('closed','old','u','p',100,200,1,'failed',100,100);`);
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  expect(db.prepare('SELECT contract_verified_at FROM wechat_sub').first().contract_verified_at).toBeNull();
  const insert=(order,contract)=>db.exec(`INSERT INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,created_at,updated_at)
    VALUES('${order}','${contract}','u','p',100,200,1,'charging',100,100)`);
  insert('retry','new');
  expect(()=>insert('duplicate','another')).toThrow(/UNIQUE constraint/);
  expect(()=>db.exec("UPDATE wechat_txn SET status='paid' WHERE out_trade_no='closed'")).toThrow(/UNIQUE constraint/);
  expect(db.prepare('PRAGMA integrity_check').first().integrity_check).toBe('ok');
});
