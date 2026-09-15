// 微信委托代扣：签约 → Cron 发起扣费 → 微信成功回调入账，全部在 D1 上可重复执行。
import { describe, it, expect } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { SUB_GRANT_SUANLI, suanliToUY, uyToSuanli, SIGNUP_GRANT_UY } from "../src/usage.js";
import { addCalendarMonth, handleWechatPayRoute, runWechatPaySchedule, wechatChargeScheduleAt, wechatV2Sign, wechatV2Xml, parseWechatXml } from "../src/wechat-pay.js";

const SQL = usageSql();
const TOK = "anon_unittesttoken_abcdefghijklmnop";
const NOW = Date.UTC(2026, 0, 31, 12, 0, 0); // 专门覆盖月末加自然月

function env(db) {
  return {
    USAGE: db, SESSION_SECRET: "",
    FILES: { get: async (key) => key === "config/wechat-pay.json" ? { text: async () => '{"enabled":true}' } : null },
    WECHAT_PAY_MCH_ID: "1900000001", WECHAT_PAY_APP_ID: "wx1234567890", WECHAT_PAY_PLAN_ID: "plan_monthly_19_9",
    WECHAT_PAY_API_V2_KEY: "unit-test-api-key",
    WECHAT_PAY_CHARGE_MODE: "notify_after_24h",
    WECHAT_PAY_CALLBACK_BASE_URL: "https://jianshuo.dev",
  };
}

const request = (path, { method = "GET", token, body, raw } = {}) => new Request("https://jianshuo.dev" + path, {
  method, headers: token ? { Authorization: "Bearer " + token } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined),
});
const signed = (e, values) => wechatV2Xml({ appid:e.WECHAT_PAY_APP_ID,mch_id:e.WECHAT_PAY_MCH_ID,
  change_type:values.cancel_reason ? 'DELETE' : 'ADD', time_end:'20260131200000', ...values }, e.WECHAT_PAY_API_V2_KEY);

function precontractFetcher(calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    expect(String(url)).toBe("https://api.mch.weixin.qq.com/papay/preentrustweb");
    const body = parseWechatXml(init.body);
    expect(wechatV2Sign(body, "unit-test-api-key")).toBe(body.sign);
    return new Response(wechatV2Xml({
      return_code: "SUCCESS", result_code: "SUCCESS", appid: "wx1234567890", mch_id: "1900000001",
      pre_entrustweb_id: "pre-entrust-001", miniprogram_username: "gh_wechatpay", miniprogram_path: "pages/sign?pre_entrustweb_id=pre-entrust-001",
    }, "unit-test-api-key"));
  };
}

const defaultPrecontractFetcher = precontractFetcher();
const call = (e, path, opts, now = NOW, fetcher = defaultPrecontractFetcher, ctx = null) => handleWechatPayRoute(new URL("https://jianshuo.dev" + path), request(path, opts), e, fetcher, now, ctx);

function applyFetcher(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const body = parseWechatXml(init.body);
    expect(wechatV2Sign(body, "unit-test-api-key")).toBe(body.sign); // 出站请求确实签名
    if (String(url) === "https://api.mch.weixin.qq.com/papay/querycontract") {
      expect(body).toMatchObject({ appid: "wx1234567890", mch_id: "1900000001", contract_id: "contract-001", version: "1.0" });
      return new Response(wechatV2Xml({
        return_code: "SUCCESS", result_code: "SUCCESS", appid: "wx1234567890", mch_id: "1900000001",
        contract_id: body.contract_id, plan_id: "plan_monthly_19_9", contract_state: "0",
      }, "unit-test-api-key"));
    }
    return new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:'wx1234567890',mch_id:'1900000001',
      ...(String(url).endsWith('orderquery') ? {out_trade_no:body.out_trade_no,trade_state:'USERPAYING'} : {})},'unit-test-api-key'));
  };
}

function terminateFetcher(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    expect(String(url)).toBe("https://api.mch.weixin.qq.com/papay/deletecontract");
    const body = parseWechatXml(init.body);
    expect(wechatV2Sign(body, "unit-test-api-key")).toBe(body.sign);
    expect(body).toMatchObject({
      appid: "wx1234567890", mch_id: "1900000001", contract_id: "contract-001", version: "1.0",
      contract_termination_remark: "用户在 VoiceDrop App 解除自动续费",
    });
    return new Response(wechatV2Xml({
      return_code: "SUCCESS", result_code: "SUCCESS", appid: "wx1234567890", mch_id: "1900000001", contract_id: body.contract_id,
    }, "unit-test-api-key"));
  };
}

async function createAndSign(e, db) {
  const created = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, NOW);
  expect(created.status).toBe(200);
  const { contract_code } = await created.json();
  const r = await call(e, "/agent/wechat-pay/contract-notify", {
    method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code, contract_id: "contract-001", plan_id: e.WECHAT_PAY_PLAN_ID, openid: "openid-1" }),
  }, NOW);
  expect(await r.text()).toContain("SUCCESS");
  return contract_code;
}

describe("微信委托代扣的日期与签名", () => {
  it("按自然月计算：1 月 31 日续到 2 月最后一天，不是固定 30 天", () => {
    expect(new Date(addCalendarMonth(NOW)).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(new Date(addCalendarMonth(Date.UTC(2024, 0, 31))).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("续期申请固定为到期日前第 3 个北京时间自然日 02:00", () => {
    // 2026-02-28 20:00 北京时间到期 → 2026-02-25 02:00 北京时间申请。
    const periodEnd = Date.UTC(2026, 1, 28, 12, 0, 0);
    expect(new Date(wechatChargeScheduleAt(periodEnd)).toISOString()).toBe("2026-02-24T18:00:00.000Z");
  });

  it("V2 回调必须验 MD5 签名，字段重复或实体 XML 会拒绝", () => {
    const values = { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: "wd1" };
    const xml = wechatV2Xml(values, "key");
    const parsed = parseWechatXml(xml);
    expect(wechatV2Sign(parsed, "key")).toBe(parsed.sign);
    expect(parseWechatXml("<!DOCTYPE x [<!ENTITY a 'bad'>]><xml><x>&a;</x></xml>")).toBeNull();
    expect(parseWechatXml("<xml><x>1</x><x>2</x></xml>")).toBeNull();
  });
});

describe("微信签约、自动续费和入账", () => {
  it("签约成功回调立刻在 waitUntil 发起首期扣费；每日 Cron 只负责后续/失败兜底", async () => {
    const db = fakeD1(SQL); const e = env(db);
    const created = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    const { contract_code } = await created.json();
    const calls = []; const background = [];
    const ctx = { waitUntil(p) { background.push(p); } };
    const signedResponse = await call(e, "/agent/wechat-pay/contract-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code, contract_id: "contract-first", plan_id: e.WECHAT_PAY_PLAN_ID }),
    }, NOW, applyFetcher(calls), ctx);
    expect(await signedResponse.text()).toContain("SUCCESS");
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.mch.weixin.qq.com/pay/pappayapply");
    expect(db.prepare("SELECT status,period_start_at,period_end_at FROM wechat_txn WHERE contract_code=?").bind(contract_code).first())
      .toMatchObject({ status: "charging", period_start_at: NOW, period_end_at: addCalendarMonth(NOW) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_event WHERE contract_code=? AND event_type='initial_charge_triggered'").bind(contract_code).first().n).toBe(1);
  });

  it("签约先由已登录用户创建 pending 行；签约回调验签后才变 active", async () => {
    const db = fakeD1(SQL); const e = env(db);
    const r = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    const b = await r.json();
    expect(b).toMatchObject({ ok: true, pre_entrustweb_id: "pre-entrust-001", wechat_mini_program_username: "gh_wechatpay" });
    expect(b.wechat_mini_program_path).toContain("pre_entrustweb_id=pre-entrust-001");
    expect(b.expires_at).toBe(NOW + 2 * 60 * 60 * 1000);
    for (const sensitive of ["appid", "mch_id", "plan_id", "contract_notify_url", "pay_notify_url", "cancel_notify_url", "sign"]) expect(b).not.toHaveProperty(sensitive);
    const scope = await anonScopeFromToken(TOK);
    expect(db.prepare("SELECT user_sub,status FROM wechat_sub WHERE contract_code=?").bind(b.contract_code).first()).toMatchObject({ user_sub: scope, status: "pending" });
    const bad = await call(e, "/agent/wechat-pay/contract-notify", { method: "POST", raw: "<xml><return_code>SUCCESS</return_code></xml>" });
    expect(await bad.text()).toContain("BAD SIGN");
    expect(db.prepare("SELECT status FROM wechat_sub WHERE contract_code=?").bind(b.contract_code).first().status).toBe("pending");
    const ok = await call(e, "/agent/wechat-pay/contract-notify", { method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: b.contract_code, contract_id: "contract-001", plan_id: e.WECHAT_PAY_PLAN_ID }) });
    expect(await ok.text()).toContain("SUCCESS");
    expect(db.prepare("SELECT status,contract_id,next_charge_at FROM wechat_sub WHERE contract_code=?").bind(b.contract_code).first()).toMatchObject({ status: "active", contract_id: "contract-001", next_charge_at: NOW });
  });

  it("已有有效 iOS 订阅时，Android/微信不能创建预签约或产生待签约行", async () => {
    const db = fakeD1(SQL); const e = env(db); const scope = await anonScopeFromToken(TOK);
    await db.prepare("INSERT INTO iap_sub (original_txn_id,user_sub,product_id,expires_date,status,updated_at) VALUES (?,?,?,?,?,?)")
      .bind("ios-active-1", scope, "monthly_19_9", NOW + 86400000, "active", NOW).run();
    const r = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "already-subscribed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_sub").bind().first().n).toBe(0);
  });

  it("售卖开关：首次缺失时写入开启；显式关闭后不影响已有 pending 会话继续完成", async () => {
    const db = fakeD1(SQL); const e = env(db);
    const writes = [];
    e.FILES = {
      get: async () => null,
      put: async (key, value, options) => writes.push({ key, value, options }),
    };
    const missing = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(missing.status).toBe(200);
    expect(writes).toEqual([{
      key: "config/wechat-pay.json", value: JSON.stringify({ enabled: true }),
      options: { httpMetadata: { contentType: "application/json" } },
    }]);

    const blockedDb = fakeD1(SQL); const blockedEnv = env(blockedDb);
    blockedEnv.FILES = { get: async () => ({ text: async () => '{"enabled":false}' }) };
    const blocked = await call(blockedEnv, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "disabled" });
    expect(blockedDb.prepare("SELECT COUNT(*) AS n FROM wechat_sub").bind().first().n).toBe(0);

    const enabled = env(blockedDb);
    const created = await call(enabled, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(created.status).toBe(200);
    enabled.FILES = { get: async () => ({ text: async () => '{"enabled":false}' }) };
    const pending = await call(enabled, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(pending.status).toBe(200);
    const status = await (await call(enabled, "/agent/wechat-pay/status", { token: TOK })).json();
    expect(status).toMatchObject({ enabled: false, status: "pending" });
  });

  it("售卖开关读取或写入异常时默认开启，不因 R2 短暂故障关闭入口", async () => {
    const readFailed = env(fakeD1(SQL));
    readFailed.FILES = { get: async () => { throw new Error("r2 read failed"); } };
    expect((await call(readFailed, "/agent/wechat-pay/contract", { method: "POST", token: TOK })).status).toBe(200);

    const writeFailed = env(fakeD1(SQL));
    writeFailed.FILES = { get: async () => null, put: async () => { throw new Error("r2 write failed"); } };
    expect((await call(writeFailed, "/agent/wechat-pay/contract", { method: "POST", token: TOK })).status).toBe(200);
  });

  it("预签约请求由服务端签名；Android 重试不保存会话，微信失败不泄露原始信息", async () => {
    const db = fakeD1(SQL); const e = env(db); const calls = [];
    const first = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, NOW, precontractFetcher(calls));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(calls).toHaveLength(1);
    const outbound = parseWechatXml(calls[0].init.body);
    expect(outbound).toMatchObject({ plan_id: e.WECHAT_PAY_PLAN_ID, contract_code: body.contract_code, notify_url: "https://jianshuo.dev/agent/wechat-pay/contract-notify", return_app: "Y", version: "1.0" });
    expect(outbound.request_serial).toMatch(/^[1-9][0-9]{17}$/);
    const retry = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, NOW + 1, precontractFetcher(calls));
    expect(await retry.json()).toMatchObject({ contract_code: body.contract_code, pre_entrustweb_id: body.pre_entrustweb_id });
    expect(calls).toHaveLength(2);
    expect(db.prepare("PRAGMA table_info(wechat_sub)").bind().all().results.map((x) => x.name)).not.toContain("pre_entrustweb_id");

    const badDb = fakeD1(SQL); const badEnv = env(badDb);
    const failed = await call(badEnv, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, NOW, async () => new Response(wechatV2Xml({
      return_code: "SUCCESS", result_code: "FAIL", err_code: "PAYAUTHERROR", err_code_des: "merchant permission is missing",
    }, badEnv.WECHAT_PAY_API_V2_KEY)));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "contract-unavailable" });
    const event = badDb.prepare("SELECT payload,message FROM wechat_event WHERE event_type='precontract_failed'").bind().first();
    expect(event.message).toContain("merchant permission");
    expect(event.payload || "").not.toContain("pre_entrustweb_id");
  });

  it("每日 Cron 只用 D1 due 索引生成稳定订单号；失败可重试，微信受理后不重复申请", async () => {
    const db = fakeD1(SQL); const e = env(db); await createAndSign(e, db);
    const calls = [];
    const first = await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    expect(first).toMatchObject({ created: 1, requested: 1, failed: 0 });
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.mch.weixin.qq.com/papay/querycontract",
      "https://api.mch.weixin.qq.com/pay/pappayapply",
    ]);
    const txn = db.prepare("SELECT * FROM wechat_txn").bind().first();
    expect(txn).toMatchObject({ status: "charging", amount_fen: 1990, period_start_at: NOW, period_end_at: addCalendarMonth(NOW) });
    await runWechatPaySchedule(e, NOW + 86400000, applyFetcher(calls));
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.mch.weixin.qq.com/papay/querycontract",
      "https://api.mch.weixin.qq.com/pay/pappayapply",
      "https://api.mch.weixin.qq.com/pay/orderquery",
      "https://api.mch.weixin.qq.com/papay/querycontract",
    ]); // 同一期同一 out_trade_no，不会被 Cron 重复申请
  });

  it("漏掉微信解约回调时，Cron 先查询协议并停止未申请的续费订单", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), init });
      const requestBody = parseWechatXml(init.body);
      expect(wechatV2Sign(requestBody, e.WECHAT_PAY_API_V2_KEY)).toBe(requestBody.sign);
      if (String(url) === "https://api.mch.weixin.qq.com/papay/querycontract") {
        return new Response(signed(e, {
          return_code: "SUCCESS", result_code: "SUCCESS", appid: e.WECHAT_PAY_APP_ID, mch_id: e.WECHAT_PAY_MCH_ID,
          contract_id: "contract-001", plan_id: e.WECHAT_PAY_PLAN_ID, contract_state: "1",
          contract_termination_mode: "2", contract_termination_remark: "user cancelled",
        }));
      }
      throw new Error("申请扣款不应被调用");
    };
    const result = await runWechatPaySchedule(e, NOW, fetcher);
    expect(result).toMatchObject({ created: 0, requested: 0, cancelled: 1 });
    expect(calls.map((x) => x.url)).toEqual(["https://api.mch.weixin.qq.com/papay/querycontract"]);
    expect(db.prepare("SELECT status,next_charge_at,cancel_reason FROM wechat_sub WHERE contract_code=?").bind(code).first())
      .toMatchObject({ status: "cancelled", next_charge_at: null, cancel_reason: "wechat-query-terminated" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_txn WHERE contract_code=?").bind(code).first().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_event WHERE contract_code=? AND event_type='contract_reconciled_cancelled'").bind(code).first().n).toBe(1);
  });

  it("协议状态查询异常时，Cron 延后扣款而不是在未知状态下申请", async () => {
    const db = fakeD1(SQL); const e = env(db); await createAndSign(e, db);
    const result = await runWechatPaySchedule(e, NOW, async (url) => {
      expect(String(url)).toBe("https://api.mch.weixin.qq.com/papay/querycontract");
      return new Response("upstream unavailable", { status: 503 });
    });
    expect(result).toMatchObject({ created: 0, requested: 0, deferred: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_txn").bind().first().n).toBe(0);
    expect(db.prepare("SELECT status FROM wechat_sub").bind().first().status).toBe("active");
  });

  it("微信明确支付失败会记录原因，并在次日重试同一个订阅周期，不会错误发放算力", async () => {
    const db = fakeD1(SQL); const e = env(db); await createAndSign(e, db);
    const calls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    const txn = db.prepare("SELECT * FROM wechat_txn").bind().first();
    const failed = await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "FAIL", out_trade_no: txn.out_trade_no, err_code: "NOTENOUGH", err_code_des: "余额不足" }),
    });
    expect(await failed.text()).toContain("SUCCESS");
    const stored = db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?").bind(txn.out_trade_no).first();
    expect(stored).toMatchObject({ status: "failed", failure_code: "NOTENOUGH", next_try_at: Date.UTC(2026,1,0,18) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='subscription'").bind().first().n).toBe(0);
    const userStatus = await (await call(e, "/agent/wechat-pay/status", { token: TOK })).json();
    expect(userStatus).toMatchObject({ payment_issue: "payment-failed" });
    expect(userStatus).not.toHaveProperty("last_error_code");
    expect(userStatus).not.toHaveProperty("last_error_message");
    await runWechatPaySchedule(e, NOW + 86400000, applyFetcher(calls));
    expect(calls).toHaveLength(4); // 每次重试前都先查询协议，再申请扣款
    expect(db.prepare("SELECT out_trade_no,status FROM wechat_txn").bind().first()).toMatchObject({ out_trade_no: txn.out_trade_no, status: "charging" });
  });

  it("支付成功回调才发 200 算力；重复回调幂等，桶严格在自然月末到期", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const calls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    const txn = db.prepare("SELECT * FROM wechat_txn WHERE contract_code=?").bind(code).first();
    const callback = { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: txn.out_trade_no, total_fee: "1990", contract_id: "contract-001", transaction_id: "4200000000001" };
    const response = await call(e, "/agent/wechat-pay/pay-notify", { method: "POST", raw: signed(e, callback) });
    expect(await response.text()).toContain("SUCCESS");
    const scope = await anonScopeFromToken(TOK);
    const bucket = db.prepare("SELECT * FROM bucket WHERE user_sub=? AND source='subscription'").bind(scope).first();
    expect(bucket.amount_uy).toBe(suanliToUY(SUB_GRANT_SUANLI));
    expect(bucket.expires_at).toBe(addCalendarMonth(NOW));
    const signupSuanli = Math.round(uyToSuanli(SIGNUP_GRANT_UY));
    const balance = db.prepare("SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=?").bind(scope).first().s;
    expect(Math.round(uyToSuanli(balance))).toBe(signupSuanli + SUB_GRANT_SUANLI);
    await call(e, "/agent/wechat-pay/pay-notify", { method: "POST", raw: signed(e, callback) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE user_sub=? AND source='subscription'").bind(scope).first().n).toBe(1);
    const sub = db.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(code).first();
    expect(sub.next_charge_at).toBe(wechatChargeScheduleAt(addCalendarMonth(NOW)));
    const event = db.prepare("SELECT * FROM wechat_event WHERE out_trade_no=? AND event_type='payment_settled'").bind(txn.out_trade_no).first();
    expect(event).toMatchObject({ contract_code: code, status_before: "settling", status_after: "paid", wechat_txn_id: "4200000000001" });
    expect(event.payload).toContain("[redacted]"); // 回调仍可排错，但不落可复用签名
  });

  it("已受理订单在解约后才成功：发放本期算力，但协议不得被回调重新激活", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const calls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    const txn = db.prepare("SELECT * FROM wechat_txn WHERE contract_code=?").bind(code).first();
    const cancelled = await call(e, "/agent/wechat-pay/cancel-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: code, contract_id: "contract-001", cancel_reason: "user" }),
    });
    expect(await cancelled.text()).toContain("SUCCESS");
    const paid = await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: txn.out_trade_no, total_fee: "1990", contract_id: "contract-001", transaction_id: "4200000000002" }),
    });
    expect(await paid.text()).toContain("SUCCESS");
    expect(db.prepare("SELECT status,next_charge_at,cancel_reason,period_end_at FROM wechat_sub WHERE contract_code=?").bind(code).first())
      .toMatchObject({ status: "cancelled", next_charge_at: null, cancel_reason: "user", period_end_at: addCalendarMonth(NOW) });
    expect(db.prepare("SELECT status FROM wechat_txn WHERE out_trade_no=?").bind(txn.out_trade_no).first().status).toBe("paid");
    const scope = await anonScopeFromToken(TOK);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE user_sub=? AND source='subscription'").bind(scope).first().n).toBe(1);
    const after = [];
    expect(await runWechatPaySchedule(e, NOW + 15 * 60 * 1000, applyFetcher(after))).toMatchObject({ created: 0, requested: 0 });
    expect(after).toHaveLength(0);
  });

  it("用户可在 App 内解除微信自动续费：微信成功后停止后续扣费，重试安全", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const chargeCalls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(chargeCalls));
    const txn = db.prepare("SELECT * FROM wechat_txn WHERE contract_code=?").bind(code).first();
    await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: txn.out_trade_no,
        total_fee: "1990", contract_id: "contract-001", transaction_id: "4200000000003" }),
    });
    const calls = [];
    const response = await call(e, "/agent/wechat-pay/cancel", { method: "POST", token: TOK }, NOW, terminateFetcher(calls));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "cancelled", expires_date: addCalendarMonth(NOW) });
    expect(calls).toHaveLength(1);
    expect(db.prepare("SELECT status,next_charge_at,cancel_reason FROM wechat_sub WHERE contract_code=?").bind(code).first())
      .toMatchObject({ status: "cancelled", next_charge_at: null, cancel_reason: "user-cancelled-in-app" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_event WHERE contract_code=? AND event_type='contract_cancelled_by_user'").bind(code).first().n).toBe(1);

    const status = await (await call(e, "/agent/wechat-pay/status", { token: TOK }, NOW)).json();
    expect(status).toMatchObject({ active: true, can_cancel: false, status: "cancelled", expires_date: addCalendarMonth(NOW) });
    const retry = await call(e, "/agent/wechat-pay/cancel", { method: "POST", token: TOK }, NOW + 1, terminateFetcher(calls));
    expect(await retry.json()).toEqual({ ok: true, status: "cancelled", already: true, expires_date: addCalendarMonth(NOW) });
    expect(calls).toHaveLength(1);
  });

  it("App 解约被微信拒绝时不篡改本地协议，并且不向客户端暴露微信错误", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const response = await call(e, "/agent/wechat-pay/cancel", { method: "POST", token: TOK }, NOW, async (url) => {
      expect(String(url)).toBe("https://api.mch.weixin.qq.com/papay/deletecontract");
      return new Response(signed(e, { return_code: "SUCCESS", result_code: "FAIL", err_code: "CONTRACT_NOT_EXIST", err_code_des: "provider internal detail" }));
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "cancel-unavailable" });
    expect(db.prepare("SELECT status,next_charge_at,last_error_code FROM wechat_sub WHERE contract_code=?").bind(code).first())
      .toMatchObject({ status: "active", next_charge_at: NOW, last_error_code: "CONTRACT_NOT_EXIST" });
    const event = db.prepare("SELECT message FROM wechat_event WHERE contract_code=? AND event_type='contract_cancel_failed'").bind(code).first();
    expect(event.message).toContain("provider internal detail");
  });

  it("取消后可新建并签约第二份协议；旧协议保留历史，新协议才是用户当前订阅", async () => {
    const db = fakeD1(SQL); const e = env(db); const code = await createAndSign(e, db);
    const duplicate = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK });
    expect(duplicate.status).toBe(409); // 仍生效时不允许并行开两份，防止双扣
    const cancelled = await call(e, "/agent/wechat-pay/cancel-notify", { method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: code, contract_id: "contract-001", cancel_reason: "user" }) });
    expect(await cancelled.text()).toContain("SUCCESS");
    const calls = [];
    expect(await runWechatPaySchedule(e, NOW, applyFetcher(calls))).toMatchObject({ created: 0, requested: 0 });
    expect(calls).toHaveLength(0);
    const second = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, NOW + 1);
    expect(second.status).toBe(200);
    const { contract_code: secondCode } = await second.json();
    expect(secondCode).not.toBe(code);
    const signedAgain = await call(e, "/agent/wechat-pay/contract-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: secondCode, contract_id: "contract-002", plan_id: e.WECHAT_PAY_PLAN_ID }),
    }, NOW + 1);
    expect(await signedAgain.text()).toContain("SUCCESS");
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_sub WHERE user_sub=(SELECT user_sub FROM wechat_sub WHERE contract_code=?)").bind(code).first().n).toBe(2);
    expect(db.prepare("SELECT status,cancel_reason FROM wechat_sub WHERE contract_code=?").bind(code).first()).toMatchObject({ status: "cancelled", cancel_reason: "user" });
    expect(db.prepare("SELECT status,contract_id FROM wechat_sub WHERE contract_code=?").bind(secondCode).first()).toMatchObject({ status: "active", contract_id: "contract-002" });
    const status = await (await call(e, "/agent/wechat-pay/status", { token: TOK }, NOW + 2)).json();
    expect(status).toMatchObject({ status: "active", plan_id: e.WECHAT_PAY_PLAN_ID });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_event WHERE contract_code=? AND event_type='contract_cancelled'").bind(code).first().n).toBe(1);
  });

  it("旧周期未结束时重新签约：只签约，首期按旧周期端点衔接且不立即增加算力", async () => {
    const db = fakeD1(SQL); const e = env(db); const firstCode = await createAndSign(e, db);
    const firstCalls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(firstCalls));
    const firstTxn = db.prepare("SELECT * FROM wechat_txn WHERE contract_code=?").bind(firstCode).first();
    await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: firstTxn.out_trade_no,
        total_fee: "1990", contract_id: "contract-001", transaction_id: "4200000000004" }),
    });
    const oldEnd = addCalendarMonth(NOW);
    await call(e, "/agent/wechat-pay/cancel-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: firstCode, contract_id: "contract-001", cancel_reason: "user" }),
    }, NOW + 1000);

    const resubscribeAt = NOW + 5 * 86400000;
    const created = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, resubscribeAt);
    const { contract_code: secondCode } = await created.json();
    const background = [];
    const ctx = { waitUntil(p) { background.push(p); } };
    const signedAgain = await call(e, "/agent/wechat-pay/contract-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: secondCode, contract_id: "contract-002", plan_id: e.WECHAT_PAY_PLAN_ID }),
    }, resubscribeAt, defaultPrecontractFetcher, ctx);
    expect(await signedAgain.text()).toContain("SUCCESS");
    expect(background).toHaveLength(0); // 第二份协议不能在签约回调中立即扣款
    const second = db.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(secondCode).first();
    expect(second).toMatchObject({ status: "active", contract_id: "contract-002", period_start_at: null, period_end_at: oldEnd,
      next_charge_at: wechatChargeScheduleAt(oldEnd) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wechat_txn WHERE contract_code=?").bind(secondCode).first().n).toBe(0);
    const status = await (await call(e, "/agent/wechat-pay/status", { token: TOK }, resubscribeAt)).json();
    expect(status).toMatchObject({ active: true, status: "active", can_cancel: true, expires_date: oldEnd, scheduled_charge_at: wechatChargeScheduleAt(oldEnd) });

    const notYet = [];
    await runWechatPaySchedule(e, wechatChargeScheduleAt(oldEnd) - 1, async (url) => { notYet.push(String(url)); throw new Error("不应提前调用微信"); });
    expect(notYet).toHaveLength(0);
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), body: parseWechatXml(init.body) });
      const body = parseWechatXml(init.body);
      if (String(url) === "https://api.mch.weixin.qq.com/papay/querycontract") {
        expect(body.contract_id).toBe("contract-002");
        return new Response(signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", appid: e.WECHAT_PAY_APP_ID, mch_id: e.WECHAT_PAY_MCH_ID,
          contract_id: "contract-002", plan_id: e.WECHAT_PAY_PLAN_ID, contract_state: "0" }));
      }
      expect(String(url)).toBe("https://api.mch.weixin.qq.com/pay/pappayapply");
      return new Response(wechatV2Xml({return_code:'SUCCESS',result_code:'SUCCESS',appid:'wx1234567890',mch_id:'1900000001',
      ...(String(url).endsWith('orderquery') ? {out_trade_no:body.out_trade_no,trade_state:'USERPAYING'} : {})},'unit-test-api-key'));
    };
    await runWechatPaySchedule(e, wechatChargeScheduleAt(oldEnd), fetcher);
    expect(calls.map((x) => x.url)).toEqual(["https://api.mch.weixin.qq.com/papay/querycontract", "https://api.mch.weixin.qq.com/pay/pappayapply"]);
    expect(db.prepare("SELECT period_start_at,period_end_at,status FROM wechat_txn WHERE contract_code=?").bind(secondCode).first())
      .toMatchObject({ period_start_at: oldEnd, period_end_at: addCalendarMonth(oldEnd), status: "charging" });
  });

  it("临近旧周期重新签约时，首期立即申请；周期仍从旧周期结束时间开始", async () => {
    const db = fakeD1(SQL); const e = env(db); const firstCode = await createAndSign(e, db);
    const firstCalls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(firstCalls));
    const firstTxn = db.prepare("SELECT * FROM wechat_txn WHERE contract_code=?").bind(firstCode).first();
    await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", out_trade_no: firstTxn.out_trade_no,
        total_fee: "1990", contract_id: "contract-001", transaction_id: "4200000000005" }),
    });
    const oldEnd = addCalendarMonth(NOW);
    await call(e, "/agent/wechat-pay/cancel-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: firstCode, contract_id: "contract-001", cancel_reason: "user" }),
    });
    const late = oldEnd - 20 * 60 * 60 * 1000;
    const created = await call(e, "/agent/wechat-pay/contract", { method: "POST", token: TOK }, late);
    const { contract_code: secondCode } = await created.json();
    const calls = []; const background = [];
    const signedAgain = await call(e, "/agent/wechat-pay/contract-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "SUCCESS", contract_code: secondCode, contract_id: "contract-002", plan_id: e.WECHAT_PAY_PLAN_ID }),
    }, late, applyFetcher(calls), { waitUntil(p) { background.push(p); } });
    expect(await signedAgain.text()).toContain("SUCCESS");
    await Promise.all(background);
    expect(calls.map((x) => x.url)).toEqual(["https://api.mch.weixin.qq.com/pay/pappayapply"]);
    const second = db.prepare("SELECT period_start_at,period_end_at,next_charge_at FROM wechat_sub WHERE contract_code=?").bind(secondCode).first();
    expect(second).toEqual({ period_start_at: null, period_end_at: oldEnd, next_charge_at: wechatChargeScheduleAt(oldEnd) });
    expect(db.prepare("SELECT period_start_at,period_end_at,status FROM wechat_txn WHERE contract_code=?").bind(secondCode).first())
      .toMatchObject({ period_start_at: oldEnd, period_end_at: addCalendarMonth(oldEnd), status: "charging" });
  });

  it("状态接口沿用 iAP 的订阅桶口径；无 token / 配置不全分别拒绝或降级", async () => {
    const db = fakeD1(SQL); const e = env(db);
    expect((await call(e, "/agent/wechat-pay/contract", { method: "POST" })).status).toBe(401);
    const off = { USAGE: db };
    expect((await call(off, "/agent/wechat-pay/contract", { method: "POST", token: TOK })).status).toBe(503);
    const modeMissing = env(db);
    delete modeMissing.WECHAT_PAY_CHARGE_MODE;
    expect((await call(modeMissing, "/agent/wechat-pay/contract", { method: "POST", token: TOK })).status).toBe(503);
    expect(await runWechatPaySchedule(modeMissing, NOW)).toEqual({ skipped: "degraded" });
    const status = await call(e, "/agent/wechat-pay/status", { token: TOK });
    expect(await status.json()).toMatchObject({ active: false, enabled: true, monthly_suanli: SUB_GRANT_SUANLI });
  });
});
