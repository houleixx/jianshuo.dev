// test/iap.test.js — 苹果订阅（P3）：claim 幂等入账 / 绑定 / 通知 / 退款回收。
import { vi, describe, it, expect, beforeAll } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { fakeD1, fakeFetch, usageSql } from "./fakes.js";
import { handleIapRoute, processTransaction, revokeTransaction, appleJWT, decodeJWSPayload } from "../src/iap.js";
import { SUB_PRODUCT_MONTHLY, SUB_GRANT_SUANLI, SUB_BUCKET_GRACE_MS, suanliToUY } from "../src/usage.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";

const SQL = usageSql();
const TOK = "anon_unittesttoken_abcdefghijklmnop";
const PROD = "https://api.storekit.itunes.apple.com";
const SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";

const b64url = (s) => Buffer.from(s).toString("base64url");
const fakeJWS = (payload) => `${b64url(JSON.stringify({ alg: "ES256" }))}.${b64url(JSON.stringify(payload))}.sig`;

// 造一个能通过 importP8 的真 EC P-256 私钥（base64(PEM)），appleJWT 走真 WebCrypto 签名。
let KEY_B64;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
  KEY_B64 = Buffer.from(pem).toString("base64");
});

function mkEnv(db, routes = {}) {
  return {
    USAGE: db, SESSION_SECRET: "",
    ASC_API_KEY_ID: "KEYID123", ASC_API_ISSUER_ID: "issuer-uuid", ASC_API_KEY_CONTENT: KEY_B64,
    _fetch: fakeFetch(routes),
  };
}
const req = (path, { method = "GET", token, body } = {}) =>
  new Request("https://jianshuo.dev" + path, {
    method,
    headers: token ? { Authorization: "Bearer " + token } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
const call = (env, path, opts) => handleIapRoute(new URL("https://jianshuo.dev" + path), req(path, opts), env, env._fetch);

function txnPayload(over = {}) {
  return {
    transactionId: "1000000001", originalTransactionId: "1000000001",
    bundleId: "com.wangjianshuo.VoiceDrop", productId: SUB_PRODUCT_MONTHLY,
    expiresDate: Date.now() + 30 * 86400000, environment: "Production",
    type: "Auto-Renewable Subscription", ...over,
  };
}
const appleRoute = (payload, base = PROD) => ({
  [`GET ${base}/inApps/v1/transactions/${payload.transactionId}`]:
    () => ({ ok: true, status: 200, body: { signedTransactionInfo: fakeJWS(payload) } }),
});

async function suanli(db, scope) {
  const now = Date.now();
  const r = db.prepare("SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=? AND (expires_at IS NULL OR expires_at > ?)").bind(scope, now).first();
  return Math.round((r.s * 23) / 1e6);
}

describe("appleJWT", () => {
  it("产出 ES256 JWT：kid/iss/aud/bid 齐全，exp 5 分钟", async () => {
    const env = mkEnv(fakeD1(SQL));
    const jwt = await appleJWT(env, 1_700_000_000_000);
    const [h, p, s] = jwt.split(".");
    expect(decodeJWSPayload(jwt)).toMatchObject({ iss: "issuer-uuid", aud: "appstoreconnect-v1", bid: "com.wangjianshuo.VoiceDrop" });
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    expect(header).toMatchObject({ alg: "ES256", kid: "KEYID123", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.exp - payload.iat).toBe(300);
    expect(s.length).toBeGreaterThan(60); // 真签名（P-256 raw 64 字节）
  });
});

describe("POST /agent/iap/claim", () => {
  it("首次 claim：回查苹果 → 发 200 算力桶（过期=苹果周期末+宽限），记 iap_txn/iap_sub", async () => {
    const db = fakeD1(SQL);
    const payload = txnPayload();
    const env = mkEnv(db, appleRoute(payload));
    const scope = await anonScopeFromToken(TOK);
    const r = await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, granted: true, suanli: SUB_GRANT_SUANLI });
    expect(await suanli(db, scope)).toBe(500 + SUB_GRANT_SUANLI); // signup 500 + 订阅 200
    const bucket = db.prepare("SELECT * FROM bucket WHERE source='subscription'").bind().first();
    expect(bucket.expires_at).toBe(payload.expiresDate + SUB_BUCKET_GRACE_MS);
    expect(bucket.amount_uy).toBe(suanliToUY(SUB_GRANT_SUANLI));
    const txn = db.prepare("SELECT * FROM iap_txn").bind().first();
    expect(txn).toMatchObject({ transaction_id: "1000000001", user_sub: scope, bucket_id: bucket.id });
    expect(db.prepare("SELECT * FROM iap_sub").bind().first()).toMatchObject({ user_sub: scope, status: "active" });
  });

  it("同一 transaction_id 重复 claim 幂等：不重复发钱", async () => {
    const db = fakeD1(SQL);
    const env = mkEnv(db, appleRoute(txnPayload()));
    const scope = await anonScopeFromToken(TOK);
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    const r2 = await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    const body = await r2.json();
    expect(body).toMatchObject({ ok: true, granted: false, already: true });
    expect(await suanli(db, scope)).toBe(500 + SUB_GRANT_SUANLI);
  });

  it("续费 = 新 transactionId 同 originalTransactionId → 再发一桶（月月 200）", async () => {
    const db = fakeD1(SQL);
    const first = txnPayload();
    const renew = txnPayload({ transactionId: "1000000002", expiresDate: Date.now() + 60 * 86400000 });
    const env = mkEnv(db, { ...appleRoute(first), ...appleRoute(renew) });
    const scope = await anonScopeFromToken(TOK);
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    const r = await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000002" } });
    expect((await r.json()).granted).toBe(true);
    expect(await suanli(db, scope)).toBe(500 + 2 * SUB_GRANT_SUANLI);
  });

  it("同一订阅链换账号 claim → 409 bound-elsewhere，不发钱", async () => {
    const db = fakeD1(SQL);
    const env = mkEnv(db, appleRoute(txnPayload()));
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    const r = await call(env, "/agent/iap/claim", { method: "POST", token: "anon_othertoken_abcdefghijklmnopqrs", body: { transaction_id: "1000000001" } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("bound-elsewhere");
  });

  it("已过期的交易：记账但不发钱（historic claim 不白送）", async () => {
    const db = fakeD1(SQL);
    const env = mkEnv(db, appleRoute(txnPayload({ expiresDate: Date.now() - 1000 })));
    const r = await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    expect((await r.json())).toMatchObject({ ok: true, granted: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bucket WHERE source='subscription'").bind().first().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM iap_txn").bind().first().n).toBe(1); // 记账了，只是不发钱
  });

  it("生产 404 → sandbox 兜底命中（TestFlight 交易）", async () => {
    const db = fakeD1(SQL);
    const payload = txnPayload({ environment: "Sandbox" });
    const env = mkEnv(db, appleRoute(payload, SANDBOX)); // 只在 sandbox 有路由，生产默认 404
    const r = await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    expect((await r.json()).granted).toBe(true);
    expect(db.prepare("SELECT environment FROM iap_txn").bind().first().environment).toBe("Sandbox");
  });

  it("苹果两边都查无 → 404；产品不对 → 400；缺 secrets → 503；无 token → 401", async () => {
    const db = fakeD1(SQL);
    const env = mkEnv(db, {});
    expect((await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "nope" } })).status).toBe(404);
    const env2 = mkEnv(db, appleRoute(txnPayload({ productId: "com.evil.other" })));
    expect((await call(env2, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } })).status).toBe(400);
    const env3 = { USAGE: db, SESSION_SECRET: "", _fetch: fakeFetch({}) };
    expect((await call(env3, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "x" } })).status).toBe(503);
    expect((await call(env2, "/agent/iap/claim", { method: "POST", body: { transaction_id: "x" } })).status).toBe(401);
  });
});

describe("POST /agent/iap/notifications (ASN V2)", () => {
  const asnBody = (type, txnPayloadObj) => ({
    signedPayload: fakeJWS({ notificationType: type, data: { signedTransactionInfo: fakeJWS(txnPayloadObj) } }),
  });

  it("DID_RENEW：回查苹果后经绑定表入账（客户端不在场也月月到账）", async () => {
    const db = fakeD1(SQL);
    const first = txnPayload();
    const renew = txnPayload({ transactionId: "1000000002", expiresDate: Date.now() + 60 * 86400000 });
    const env = mkEnv(db, { ...appleRoute(first), ...appleRoute(renew) });
    const scope = await anonScopeFromToken(TOK);
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } }); // 建立绑定
    const r = await call(env, "/agent/iap/notifications", { method: "POST", body: asnBody("DID_RENEW", renew) });
    expect(r.status).toBe(200);
    expect((await r.json()).granted).toBe(true);
    expect(await suanli(db, scope)).toBe(500 + 2 * SUB_GRANT_SUANLI);
  });

  it("通知里的交易内容不可信：入账金额以回查结果为准（伪造 payload 查无 → 跳过）", async () => {
    const db = fakeD1(SQL);
    const env = mkEnv(db, {}); // 苹果查无任何交易
    const r = await call(env, "/agent/iap/notifications", { method: "POST", body: asnBody("DID_RENEW", txnPayload()) });
    expect(r.status).toBe(200);
    expect((await r.json())).toMatchObject({ ok: true, skipped: "not-found" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM iap_txn").bind().first().n).toBe(0);
  });

  it("绑定还没建立（用户从未 claim）→ 跳过不报错，等客户端兜底", async () => {
    const db = fakeD1(SQL);
    const payload = txnPayload();
    const env = mkEnv(db, appleRoute(payload));
    const r = await call(env, "/agent/iap/notifications", { method: "POST", body: asnBody("SUBSCRIBED", payload) });
    expect((await r.json())).toMatchObject({ ok: true, granted: false, skipped: "no-binding" });
  });

  it("REFUND：该笔发的桶余量清零，订阅状态 revoked", async () => {
    const db = fakeD1(SQL);
    const payload = txnPayload();
    const env = mkEnv(db, appleRoute(payload));
    const scope = await anonScopeFromToken(TOK);
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    expect(await suanli(db, scope)).toBe(500 + SUB_GRANT_SUANLI);
    const r = await call(env, "/agent/iap/notifications", { method: "POST", body: asnBody("REFUND", payload) });
    expect((await r.json()).revoked).toBe(true);
    expect(await suanli(db, scope)).toBe(500);
    expect(db.prepare("SELECT status FROM iap_sub").bind().first().status).toBe("revoked");
  });

  it("坏 payload → 200 skipped（别让苹果重试风暴）", async () => {
    const env = mkEnv(fakeD1(SQL), {});
    const r = await call(env, "/agent/iap/notifications", { method: "POST", body: { signedPayload: "garbage" } });
    expect(r.status).toBe(200);
    expect((await r.json()).skipped).toBe("bad-payload");
  });
});

describe("GET /agent/iap/status", () => {
  it("未订阅 → active:false；订阅后 → active + 到期日 + 本月剩余算力", async () => {
    const db = fakeD1(SQL);
    const payload = txnPayload();
    const env = mkEnv(db, appleRoute(payload));
    let body = await (await call(env, "/agent/iap/status", { token: TOK })).json();
    expect(body.active).toBe(false);
    await call(env, "/agent/iap/claim", { method: "POST", token: TOK, body: { transaction_id: "1000000001" } });
    body = await (await call(env, "/agent/iap/status", { token: TOK })).json();
    expect(body).toMatchObject({ active: true, product_id: SUB_PRODUCT_MONTHLY, monthly_suanli: SUB_GRANT_SUANLI });
    expect(body.expires_date).toBe(payload.expiresDate);
    expect(body.sub_suanli).toBe(SUB_GRANT_SUANLI);
  });

  it("无 token → 401；非 iap 路径 → null 交回主分发", async () => {
    const env = mkEnv(fakeD1(SQL), {});
    expect((await call(env, "/agent/iap/status", {})).status).toBe(401);
    expect(await call(env, "/agent/usage/balance", { token: TOK })).toBeNull();
  });
});

describe("processTransaction / revokeTransaction 直接单元", () => {
  it("bundleId 不对 → wrong-bundle", async () => {
    const db = fakeD1(SQL);
    const r = await processTransaction(db, txnPayload({ bundleId: "com.evil.app" }), "Production", "users/x/", Date.now());
    expect(r).toMatchObject({ ok: false, error: "wrong-bundle" });
  });
  it("revocationDate 存在的交易不发钱", async () => {
    const db = fakeD1(SQL);
    const r = await processTransaction(db, txnPayload({ revocationDate: Date.now() }), "Production", "users/x/", Date.now());
    expect(r).toMatchObject({ ok: true, granted: false });
  });
  it("revoke 查无交易 → 幂等 no-op", async () => {
    const db = fakeD1(SQL);
    expect(await revokeTransaction(db, "nope", Date.now())).toMatchObject({ ok: true, revoked: false });
  });
});
