import { it, expect } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import {
  handleWechatPayRoute,
  runWechatPaySchedule,
  wechatV2Xml,
  parseWechatXml,
} from "../src/wechat-pay.js";
const NOW = Date.UTC(2026, 0, 31, 12),
  DAY = 86400000,
  TOKEN = "anon_unittesttoken_abcdefghijklmnop";
function setup() {
  const db = fakeD1(usageSql()),
    requests = [];
  const env = {
    USAGE: db,
    FILES: { get: async () => ({ text: async () => '{"enabled":true}' }) },
    WECHAT_PAY_MCH_ID: "mch",
    WECHAT_PAY_APP_ID: "app",
    WECHAT_PAY_PLAN_ID: "plan",
    WECHAT_PAY_API_V2_KEY: "test-key",
    WECHAT_PAY_CALLBACK_BASE_URL: "https://example.test",
  };
  let state = "USERPAYING";
  const fetcher = async (url, init) => {
    const p = parseWechatXml(init.body);
    requests.push({ url: String(url), p });
    return new Response(
      wechatV2Xml(
        Object.fromEntries(
          Object.entries({
            return_code: "SUCCESS",
            result_code: "SUCCESS",
            appid: "app",
            mch_id: "mch",
            pre_entrustweb_id: "pre",
            contract_id: p.contract_id || "cid",
            contract_state: "0",
            out_trade_no: p.out_trade_no,
            trade_state: state,
            total_fee: "1990",
            transaction_id: "wx-" + p.out_trade_no,
            time_end: "20260131200000",
          }).filter(([, v]) => v !== undefined),
        ),
        env.WECHAT_PAY_API_V2_KEY,
      ),
    );
  };
  async function call(path, body, at = NOW, fetch = fetcher, ctx = null) {
    const url = new URL("https://example.test/agent/wechat-pay/" + path);
    return handleWechatPayRoute(
      url,
      new Request(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer " + TOKEN },
        body: body
          ? wechatV2Xml(
              { appid: "app", mch_id: "mch", ...body },
              env.WECHAT_PAY_API_V2_KEY,
            )
          : undefined,
      }),
      env,
      fetch,
      at,
      ctx,
    );
  }
  const signBody = (c, id = "cid") => ({
    return_code: "SUCCESS",
    result_code: "SUCCESS",
    change_type: "ADD",
    contract_code: c,
    contract_id: id,
    plan_id: "plan",
    openid: "payer",
  });
  const create = async (at = NOW) => {
    const r = await call("contract", {}, at);
    return { status: r.status, ...(await r.json()) };
  };
  const sign = async (c, at = NOW, id = "cid", fetch = fetcher) => {
    const jobs = [];
    const r = await call("contract-notify", signBody(c, id), at, fetch, {
      waitUntil(p) {
        jobs.push(p);
      },
    });
    await Promise.all(jobs);
    return r;
  };
  const pay = (no, id = "cid") => ({
    return_code: "SUCCESS",
    result_code: "SUCCESS",
    out_trade_no: no,
    total_fee: "1990",
    transaction_id: "wx-" + no,
    contract_id: id,
    time_end: "20260131200000",
  });
  const txn = () =>
    db
      .prepare("SELECT * FROM wechat_txn ORDER BY created_at DESC LIMIT 1")
      .first();
  const grants = () =>
    db
      .prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='subscription'")
      .first().n;
  return {
    db,
    env,
    requests,
    fetcher,
    call,
    create,
    sign,
    signBody,
    pay,
    txn,
    grants,
    setQuery(s) {
      state = s;
    },
  };
}
it("duplicate signing creates only one first charge", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  await f.sign(c, NOW + 10000);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_txn").first().n).toBe(
    1,
  );
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    1,
  );
});
it("old signing callback cannot reactivate a cancelled contract", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  await f.call(
    "cancel-notify",
    { ...f.signBody(c), change_type: "DELETE" },
    NOW + 1000,
  );
  await f.sign(c, NOW + 10000);
  expect(f.db.prepare("SELECT status FROM wechat_sub").first().status).toBe(
    "cancelled",
  );
});
it("payment before apply response stays paid and grants once", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c, NOW, "cid", async (url, init) => {
    await f.call("pay-notify", f.pay(parseWechatXml(init.body).out_trade_no));
    return f.fetcher(url, init);
  });
  expect(f.txn().status).toBe("paid");
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  expect(f.grants()).toBe(1);
});
it("settlement rollback covers bucket, ledger and period", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  const no = f.txn().out_trade_no;
  f.db.exec(
    "CREATE TRIGGER abort_settle BEFORE UPDATE OF period_start_at ON wechat_sub WHEN NEW.period_start_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  await f.call("pay-notify", f.pay(no));
  expect(f.grants()).toBe(0);
  f.db.exec("DROP TRIGGER abort_settle");
  await f.call("pay-notify", f.pay(no));
  expect(f.grants()).toBe(1);
  expect(f.txn().status).toBe("paid");
});
it("resign waits for unresolved old renewal", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  const at = f.db
    .prepare("SELECT next_charge_at FROM wechat_sub")
    .first().next_charge_at;
  await runWechatPaySchedule(f.env, at, f.fetcher);
  await f.call(
    "cancel-notify",
    { ...f.signBody(c), change_type: "DELETE" },
    at + DAY,
  );
  expect(await f.create(at + DAY + 1000)).toMatchObject({
    status: 409,
    error: "payment-pending",
  });
});
it("lost notification is recovered by querying the original order", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  f.setQuery("SUCCESS");
  await runWechatPaySchedule(f.env, NOW + DAY, f.fetcher);
  expect(f.txn().status).toBe("paid");
  expect(f.grants()).toBe(1);
});
it("unavailable callback storage is not acknowledged as success", async () => {
  const f = setup();
  delete f.env.USAGE;
  expect(
    await (await f.call("pay-notify", f.pay("unknown"))).text(),
  ).not.toContain("<![CDATA[SUCCESS]]>");
});
it("paid subscriptions do not return first charge schedule", async () => {
  const f = setup(),
    { contract_code: c } = await f.create();
  await f.sign(c);
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  expect(
    (await (await f.call("status")).json()).scheduled_charge_at,
  ).toBeNull();
});

it("concurrent create requests share one pending authorization", async () => {
  const f = setup();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => f.create()),
  );
  expect(new Set(results.map((r) => r.contract_code)).size).toBe(1);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_sub").first().n).toBe(
    1,
  );
});

it("concurrent success notifications grant only once and keep period/bucket consistent", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  const no = f.txn().out_trade_no;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      f.call("pay-notify", f.pay(no), NOW + i * 1000),
    ),
  );
  expect(f.grants()).toBe(1);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason='subscription'")
      .first().n,
  ).toBe(1);
  expect(
    f.db.prepare("SELECT period_end_at FROM wechat_sub").first().period_end_at,
  ).toBe(
    f.db
      .prepare("SELECT expires_at FROM bucket WHERE source='subscription'")
      .first().expires_at,
  );
});

it("cancel immediately after payment then resign preserves coverage and does not charge again", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  const end = f.txn().entitlement_end_at;
  await f.call(
    "cancel-notify",
    { ...f.signBody(code), change_type: "DELETE" },
    NOW + 1000,
  );
  const second = await f.create(NOW + 2000);
  await f.sign(second.contract_code, NOW + 3000, "cid-new");
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    1,
  );
  expect(f.grants()).toBe(1);
  expect(
    (await (await f.call("status", null, NOW + 4000)).json()).expires_date,
  ).toBe(end);
});

it("early renewal grants immediately while old and new buckets expire independently", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  const oldEnd = f.txn().entitlement_end_at;
  const at = f.db
    .prepare("SELECT next_charge_at FROM wechat_sub")
    .first().next_charge_at;
  await runWechatPaySchedule(f.env, at, f.fetcher);
  const no = f.requests.filter((x) => x.url.endsWith("pappayapply")).at(-1)
    .p.out_trade_no;
  await f.call(
    "pay-notify",
    { ...f.pay(no), time_end: "20260226020000" },
    at + DAY,
  );
  const buckets = f.db
    .prepare(
      "SELECT * FROM bucket WHERE source='subscription' ORDER BY expires_at",
    )
    .all().results;
  expect(buckets).toHaveLength(2);
  expect(buckets[0].expires_at).toBe(oldEnd);
  expect(buckets[1].created_at).toBeLessThan(oldEnd);
  expect(buckets[1].expires_at).toBe(Date.UTC(2026, 2, 28, 12));
  const active = f.db
    .prepare(
      "SELECT COUNT(*) AS n FROM bucket WHERE source='subscription' AND expires_at>?",
    )
    .bind(oldEnd)
    .first();
  expect(active.n).toBe(1);
});

it("failed attempts have new merchant orders but share one cycle and stop after three", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  for (let i = 0; i < 3; i++) {
    const no = f.requests.filter((x) => x.url.endsWith("pappayapply")).at(-1)
      .p.out_trade_no;
    await f.call(
      "pay-notify",
      { ...f.pay(no), result_code: "FAIL", err_code: "NOTENOUGH" },
      NOW + i * DAY,
    );
    await runWechatPaySchedule(f.env, NOW + (i + 1) * DAY, f.fetcher);
  }
  const calls = f.requests.filter((x) => x.url.endsWith("pappayapply"));
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((x) => x.p.out_trade_no)).size).toBe(3);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_txn").first().n).toBe(
    1,
  );
  expect(f.txn()).toMatchObject({ status: "failed", attempt_count: 3 });
  expect(
    f.db
      .prepare("SELECT next_charge_at,last_error_code FROM wechat_sub")
      .first(),
  ).toMatchObject({ next_charge_at: null, last_error_code: "retry-exhausted" });
  expect(f.grants()).toBe(0);
  await f.call(
    "cancel-notify",
    { ...f.signBody(code), change_type: "DELETE" },
    NOW + 4 * DAY,
  );
  const fresh = await f.create(NOW + 4 * DAY);
  expect(fresh.status).toBe(200);
  await f.sign(fresh.contract_code, NOW + 4 * DAY, "cid-new");
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    4,
  );
});

it("apply timeout is queried and does not immediately create another charge", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code, NOW, "cid", async () => {
    throw new Error("timeout");
  });
  expect(f.db.prepare("SELECT status FROM wechat_attempt").first().status).toBe(
    "unknown",
  );
  await runWechatPaySchedule(f.env, NOW + DAY, f.fetcher);
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM wechat_attempt").first().n,
  ).toBe(1);
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    0,
  );
});

it("committed but unsent request can resend the same merchant order after verified ORDERNOTEXIST", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code, NOW, "cid", async () => {
    throw new Error("stopped before send");
  });
  const no = f.txn().out_trade_no;
  const fetcher = async (url, init) =>
    String(url).endsWith("orderquery")
      ? new Response(
          wechatV2Xml(
            {
              return_code: "SUCCESS",
              result_code: "FAIL",
              err_code: "ORDERNOTEXIST",
              appid: "app",
              mch_id: "mch",
            },
            f.env.WECHAT_PAY_API_V2_KEY,
          ),
        )
      : f.fetcher(url, init);
  await runWechatPaySchedule(f.env, NOW + DAY, fetcher);
  expect(
    f.requests
      .filter((x) => x.url.endsWith("pappayapply"))
      .map((x) => x.p.out_trade_no),
  ).toEqual([no]);
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM wechat_attempt").first().n,
  ).toBe(1);
});

it("old failed attempt notifications cannot fail a later accepted attempt", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  const old = f.txn().out_trade_no;
  const failed = { ...f.pay(old), result_code: "FAIL", err_code: "NOTENOUGH" };
  await f.call("pay-notify", failed);
  await runWechatPaySchedule(f.env, NOW + DAY, f.fetcher);
  await f.call("pay-notify", failed, NOW + DAY + 1000);
  expect(f.txn().status).toBe("charging");
});

it("payment after cancellation grants coverage without reactivating renewal", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  await f.call("cancel-notify", { ...f.signBody(code), change_type: "DELETE" });
  await f.call("pay-notify", f.pay(f.txn().out_trade_no));
  expect(f.grants()).toBe(1);
  expect(
    f.db.prepare("SELECT status,next_charge_at FROM wechat_sub").first(),
  ).toEqual({ status: "cancelled", next_charge_at: null });
});

it("pagination processes all due users, even if earlier users remain charging", async () => {
  const f = setup();
  for (let i = 0; i < 61; i++)
    f.db
      .prepare(
        "INSERT INTO wechat_sub(contract_code,contract_id,user_sub,plan_id,status,period_end_at,next_charge_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind("c" + i, "id" + i, "user" + i, "plan", "active", NOW, NOW, NOW, NOW)
      .run();
  await runWechatPaySchedule(f.env, NOW, f.fetcher);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_txn").first().n).toBe(
    61,
  );
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    61,
  );
  await runWechatPaySchedule(f.env, NOW + DAY, f.fetcher);
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    61,
  );
});

it("rejects mismatched app identity without granting", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  expect(
    await (
      await f.call("pay-notify", {
        ...f.pay(f.txn().out_trade_no),
        appid: "other-app",
      })
    ).text(),
  ).toContain("FAIL");
  expect(f.grants()).toBe(0);
});

it("failed order queries are retained in the audit log", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  await runWechatPaySchedule(
    f.env,
    NOW + DAY,
    async () => new Response("offline", { status: 503 }),
  );
  expect(
    f.db
      .prepare(
        "SELECT direction FROM wechat_event WHERE event_type='payment_query_failed'",
      )
      .first().direction,
  ).toBe("outbound");
});



it("invalid payment times never grant or acknowledge success", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  for (const time_end of ["", "20260230200000", "20270131200000"]) {
    const response = await f.call("pay-notify", {
      ...f.pay(f.txn().out_trade_no),
      time_end,
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SUCCESS");
    expect(f.grants()).toBe(0);
  }
});

it("late payment grants one full month from actual payment time", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  const paidAt = Date.UTC(2026, 1, 2, 12);
  await f.call(
    "pay-notify",
    { ...f.pay(f.txn().out_trade_no), time_end: "20260202200000" },
    paidAt,
  );
  expect(f.txn().entitlement_start_at).toBe(paidAt);
  expect(f.txn().entitlement_end_at).toBe(Date.UTC(2026, 2, 2, 12));
  expect(f.grants()).toBe(1);
});



it("a payment during the scheduler contract query cannot charge the following month", async () => {
  const f = setup(),
    { contract_code: code } = await f.create();
  await f.sign(code);
  const firstOrder = f.txn().out_trade_no;
  let settled = false;
  await runWechatPaySchedule(f.env, NOW + 1000, async (url, init) => {
    if (String(url).includes("querycontract") && !settled) {
      settled = true;
      await f.call("pay-notify", f.pay(firstOrder), NOW + 1000);
    }
    return f.fetcher(url, init);
  });
  expect(settled).toBe(true);
  expect(f.grants()).toBe(1);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_txn").first().n).toBe(
    1,
  );
  expect(f.requests.filter((x) => x.url.endsWith("pappayapply"))).toHaveLength(
    1,
  );
});
