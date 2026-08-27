// 微信委托代扣：签约 → Cron 发起扣费 → 微信成功回调入账，全部在 D1 上可重复执行。
import { describe, it, expect } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { SUB_GRANT_SUANLI, SUB_BUCKET_GRACE_MS, suanliToUY, uyToSuanli, SIGNUP_GRANT_UY } from "../src/usage.js";
import { addCalendarMonth, handleWechatPayRoute, runWechatPaySchedule, wechatV2Sign, wechatV2Xml, parseWechatXml } from "../src/wechat-pay.js";

const SQL = usageSql();
const TOK = "anon_unittesttoken_abcdefghijklmnop";
const NOW = Date.UTC(2026, 0, 31, 12, 0, 0); // 专门覆盖月末加自然月

function env(db) {
  return {
    USAGE: db, SESSION_SECRET: "",
    WECHAT_PAY_MCH_ID: "1900000001", WECHAT_PAY_APP_ID: "wx1234567890", WECHAT_PAY_PLAN_ID: "plan_monthly_19_9",
    WECHAT_PAY_API_V2_KEY: "unit-test-api-key", WECHAT_PAY_APPLY_URL: "https://pay.example.test/papay/apply",
    WECHAT_PAY_CALLBACK_BASE_URL: "https://jianshuo.dev",
  };
}

const request = (path, { method = "GET", token, body, raw } = {}) => new Request("https://jianshuo.dev" + path, {
  method, headers: token ? { Authorization: "Bearer " + token } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined),
});
const signed = (e, values) => wechatV2Xml(values, e.WECHAT_PAY_API_V2_KEY);

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
    return new Response("<xml><return_code><![CDATA[SUCCESS]]></return_code><result_code><![CDATA[SUCCESS]]></result_code></xml>");
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
  it("签约成功回调立刻在 waitUntil 发起首期扣费；15 分钟 Cron 只负责后续/失败兜底", async () => {
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

  it("Cron 只用 D1 due 索引生成稳定订单号；失败可重试，成功申请不重复下单", async () => {
    const db = fakeD1(SQL); const e = env(db); await createAndSign(e, db);
    const calls = [];
    const first = await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    expect(first).toMatchObject({ created: 1, requested: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const txn = db.prepare("SELECT * FROM wechat_txn").bind().first();
    expect(txn).toMatchObject({ status: "charging", amount_fen: 1990, period_start_at: NOW, period_end_at: addCalendarMonth(NOW) });
    await runWechatPaySchedule(e, NOW + 5 * 60 * 1000, applyFetcher(calls));
    expect(calls).toHaveLength(1); // 同一期同一 out_trade_no，不会被 Cron 重复申请
  });

  it("微信明确支付失败会记录原因并在一小时后以同一订单号重试，不会错误发放算力", async () => {
    const db = fakeD1(SQL); const e = env(db); await createAndSign(e, db);
    const calls = [];
    await runWechatPaySchedule(e, NOW, applyFetcher(calls));
    const txn = db.prepare("SELECT * FROM wechat_txn").bind().first();
    const failed = await call(e, "/agent/wechat-pay/pay-notify", {
      method: "POST", raw: signed(e, { return_code: "SUCCESS", result_code: "FAIL", out_trade_no: txn.out_trade_no, err_code: "NOTENOUGH", err_code_des: "余额不足" }),
    });
    expect(await failed.text()).toContain("SUCCESS");
    const stored = db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?").bind(txn.out_trade_no).first();
    expect(stored).toMatchObject({ status: "failed", failure_code: "NOTENOUGH", next_try_at: NOW + 60 * 60 * 1000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='subscription'").bind().first().n).toBe(0);
    const userStatus = await (await call(e, "/agent/wechat-pay/status", { token: TOK })).json();
    expect(userStatus).toMatchObject({ payment_issue: "payment-failed" });
    expect(userStatus).not.toHaveProperty("last_error_code");
    expect(userStatus).not.toHaveProperty("last_error_message");
    await runWechatPaySchedule(e, NOW + 60 * 60 * 1000, applyFetcher(calls));
    expect(calls).toHaveLength(2);
    expect(db.prepare("SELECT out_trade_no,status FROM wechat_txn").bind().first()).toMatchObject({ out_trade_no: txn.out_trade_no, status: "charging" });
  });

  it("支付成功回调才发 200 算力；重复回调幂等，桶到期=自然月末+6小时", async () => {
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
    expect(bucket.expires_at).toBe(addCalendarMonth(NOW) + SUB_BUCKET_GRACE_MS);
    const signupSuanli = Math.round(uyToSuanli(SIGNUP_GRANT_UY));
    const balance = db.prepare("SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=?").bind(scope).first().s;
    expect(Math.round(uyToSuanli(balance))).toBe(signupSuanli + SUB_GRANT_SUANLI);
    await call(e, "/agent/wechat-pay/pay-notify", { method: "POST", raw: signed(e, callback) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE user_sub=? AND source='subscription'").bind(scope).first().n).toBe(1);
    const sub = db.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(code).first();
    expect(sub.next_charge_at).toBe(addCalendarMonth(NOW) - 86400000);
    const event = db.prepare("SELECT * FROM wechat_event WHERE out_trade_no=? AND event_type='payment_settled'").bind(txn.out_trade_no).first();
    expect(event).toMatchObject({ contract_code: code, status_before: "settling", status_after: "paid", wechat_txn_id: "4200000000001" });
    expect(event.payload).toContain("[redacted]"); // 回调仍可排错，但不落可复用签名
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

  it("状态接口沿用 iAP 的订阅桶口径；无 token / 配置不全分别拒绝或降级", async () => {
    const db = fakeD1(SQL); const e = env(db);
    expect((await call(e, "/agent/wechat-pay/contract", { method: "POST" })).status).toBe(401);
    const off = { USAGE: db };
    expect((await call(off, "/agent/wechat-pay/contract", { method: "POST", token: TOK })).status).toBe(503);
    const status = await call(e, "/agent/wechat-pay/status", { token: TOK });
    expect(await status.json()).toMatchObject({ active: false, monthly_suanli: SUB_GRANT_SUANLI });
  });
});
