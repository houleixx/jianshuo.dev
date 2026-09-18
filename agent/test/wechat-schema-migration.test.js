import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fakeD1, usageSql } from './fakes.js';

it('initializes an empty database with one WeChat script and no fabricated payment or credit', () => {
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.includes('wechat'));
  expect(files).toEqual(['0005_wechat.sql']);
  const db = fakeD1(usageSql());
  for (const table of ['wechat_sub', 'wechat_txn', 'wechat_attempt', 'wechat_event', 'account', 'bucket', 'ledger'])
    expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).first().n).toBe(0);
  expect(db.prepare('PRAGMA integrity_check').first().integrity_check).toBe('ok');
});

it('allows a new agreement after cancellation but prevents concurrent live agreements', () => {
  const db = fakeD1(usageSql());
  const insert = code => db.prepare(`INSERT INTO wechat_sub(contract_code,user_sub,plan_id,status,created_at,updated_at)
    VALUES(?,'user','plan','pending',100,100)`).bind(code).run();
  insert('first');
  expect(() => insert('second')).toThrow(/UNIQUE constraint/);
  db.exec("UPDATE wechat_sub SET status='active'");
  expect(() => insert('second')).toThrow(/UNIQUE constraint/);
  db.exec("UPDATE wechat_sub SET status='cancelled'");
  insert('second');
  expect(db.prepare('SELECT COUNT(*) n FROM wechat_sub').first().n).toBe(2);
});

it('allows replacement of a failed cycle but rejects duplicate live or paid user periods', () => {
  const db = fakeD1(usageSql());
  const insert = (order, status) => db.prepare(`INSERT INTO wechat_txn
    (out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,created_at,updated_at)
    VALUES(?,?,'user','plan',100,200,1,?,100,100)`).bind(order, order, status).run();
  insert('closed', 'failed');
  insert('replacement', 'charging');
  expect(() => insert('duplicate', 'pending')).toThrow(/UNIQUE constraint/);
  expect(() => db.exec("UPDATE wechat_txn SET status='paid' WHERE out_trade_no='closed'")).toThrow(/UNIQUE constraint/);
  db.exec("UPDATE wechat_txn SET status='paid' WHERE out_trade_no='replacement'");
  expect(() => insert('duplicate', 'charging')).toThrow(/UNIQUE constraint/);
  expect(db.prepare("SELECT payment_kind,prepay_id,checkout_expires_at,request_serial FROM wechat_txn WHERE out_trade_no='replacement'").first())
    .toEqual({payment_kind:'deduct', prepay_id:null, checkout_expires_at:null, request_serial:null});
});

it('allows a new attempt after definite failure while preventing parallel attempts or reused attempt numbers', () => {
  const db = fakeD1(usageSql());
  const insert = (order, number) => db.prepare(`INSERT INTO wechat_attempt
    (out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,created_at,updated_at)
    VALUES(?,'cycle','contract','wx-contract','sending',?,100,100)`).bind(order, number).run();
  insert('first', 1);
  expect(() => insert('second', 2)).toThrow(/UNIQUE constraint/);
  db.exec("UPDATE wechat_attempt SET status='failed'");
  expect(() => insert('reused', 1)).toThrow(/UNIQUE constraint/);
  insert('second', 2);
  db.exec("UPDATE wechat_attempt SET status='paid' WHERE out_trade_no='second'");
  expect(() => insert('third', 3)).toThrow(/UNIQUE constraint/);
});

it('prevents reuse of WeChat transaction IDs and duplicate bucket or ledger grants', () => {
  const db = fakeD1(usageSql());
  db.exec(`INSERT INTO wechat_txn
    (out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,wechat_txn_id,created_at,updated_at)
    VALUES('first','contract','user','plan',100,200,1,'paid','wx-paid',100,100),
          ('next','contract','user','plan',200,300,1,'pending',NULL,200,200);
    INSERT INTO bucket(user_sub,amount_uy,remaining_uy,source,created_at,wechat_order)
      VALUES('user',200,200,'subscription',100,'first');
    INSERT INTO ledger(user_sub,ts,kind,amount_uy,reason,detail,balance_uy)
      VALUES('user',100,'grant',200,'subscription','{"provider":"wechat","out_trade_no":"first"}',200);`);
  expect(() => db.exec("UPDATE wechat_txn SET wechat_txn_id='wx-paid' WHERE out_trade_no='next'")).toThrow(/UNIQUE constraint/);
  expect(() => db.exec(`INSERT INTO bucket(user_sub,amount_uy,remaining_uy,source,created_at,wechat_order)
    VALUES('user',200,200,'subscription',100,'first')`)).toThrow(/UNIQUE constraint/);
  expect(() => db.exec(`INSERT INTO ledger(user_sub,ts,kind,amount_uy,reason,detail,balance_uy)
    SELECT user_sub,ts,kind,amount_uy,reason,detail,balance_uy FROM ledger`)).toThrow(/UNIQUE constraint/);
});
