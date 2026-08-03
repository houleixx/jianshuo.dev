// 晚到照片补写（photo backfill）：iOS 不再保证「照片先于音频到位」，照片 PUT 落盘后
// Pages 带 photoTs poke 用户的 Miner DO 分片，成熟（PBF_GRACE_MS）后由 alarm 调
// backfillSessionPhotos——与挖矿写盘同一条串行 alarm 链，竞态结构性消失。Pins:
//   - backfillSessionPhotos：成文后补末尾 / 出现过不复活 / 未成文 no-op /
//     no-speech .empty 清掉重挖 / 多张一次写盘 / 幂等 / sidecar 不误认成 doc
//   - Miner DO：photoTs 写 pbf 待办 + alarm min 语义（photo poke 不拖慢挖矿）
//   - /agent/mine/trigger：photoTs 透传给用户分片；admin ?scope= 定向 poke
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { backfillSessionPhotos, PBF_GRACE_MS } from "../src/miner.js";
import worker, { Miner } from "../src/index.js";
import { readArticleDoc, resolveArticles } from "../../functions/lib/article-store.js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

const SCOPE = "users/anon-abc/";
const TS    = "2026-08-01-120000";
const STEM  = `VoiceDrop-${TS}-10m0s-Fri-Afternoon`;
const DOCKEY   = `${SCOPE}articles/${STEM}.json`;
const EMPTYKEY = `${SCOPE}articles/${STEM}.empty`;
const REL1 = `photos/${TS}/3-a1b.jpg`;
const REL2 = `photos/${TS}/9-c2d.jpg`;

function v3doc(versions, head = versions.length) {
  return JSON.stringify({
    schema: 3, id: STEM, sourceAudio: `${STEM}.m4a`, createdAt: "2026-08-01T12:00:00Z",
    transcript: "转写", srt: "", status: "ready", model: "m", head,
    versions: versions.map((articles, i) => ({ v: i + 1, savedAt: i + 1, source: "mine", articles })),
  });
}

// StatusHub 假件：记录 notifyStatus 的广播内容。
function envWith(seed = {}) {
  const e = fakeEnv(seed);
  e.notifies = [];
  e.StatusHub = {
    idFromName: (n) => n,
    get: () => ({ fetch: async (req) => { try { e.notifies.push(JSON.parse(await req.text())); } catch {} return new Response("ok"); } }),
  };
  return e;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("backfillSessionPhotos", () => {
  it("成文后照片晚到 → 补到末篇末尾、photo-backfill 新版本、通知客户端", async () => {
    const e = envWith({
      [DOCKEY]: v3doc([[{ title: "T", body: "正文。", style: 2 }]]),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.action).toBe("backfilled");
    const doc = await readArticleDoc(e, DOCKEY);
    expect(doc.head).toBe(2);
    expect(doc.versions.at(-1).source).toBe("photo-backfill");
    const arts = resolveArticles(doc);
    expect(arts[0].body).toContain(`[[photo:${REL1}]]`);
    expect(arts[0].style).toBe(2);                       // per-article 字段存活
    expect(e.notifies).toContainEqual({ stem: STEM, status: "ready" });
  });

  it("marker 曾出现在旧版本、head 已删 = 用户意志 → 不复活、不写盘", async () => {
    const e = envWith({
      [DOCKEY]: v3doc([
        [{ title: "T", body: `正文。\n\n[[photo:${REL1}]]` }],
        [{ title: "T", body: "正文（用户删了图）。" }],
      ]),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.action).toBe("none-missing");
    expect((await readArticleDoc(e, DOCKEY)).head).toBe(2);
  });

  it("doc 与 .empty 都不存在（挖矿未写盘）→ no-op，交给未来挖矿的 fresh 重列", async () => {
    const e = envWith({ [`${SCOPE}${REL1}`]: "JPEG" });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.action).toBe("not-mined-yet");
    expect([...e.FILES._store.keys()].some((k) => k.includes("/articles/"))).toBe(false);
  });

  it("asr sidecar（.asr.json/.asrdone.json）不被误认成文章 doc", async () => {
    const e = envWith({
      [`${SCOPE}articles/${STEM}.asr.json`]: "{}",
      [`${SCOPE}articles/${STEM}.asrdone.json`]: "{}",
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    expect((await backfillSessionPhotos(e, SCOPE, TS)).action).toBe("not-mined-yet");
  });

  it("no-speech .empty + 照片晚到 → 清 .empty（同 alarm 的 runMine 看图重挖）", async () => {
    const e = envWith({
      [EMPTYKEY]: JSON.stringify({ status: "empty", reason: "no-speech" }),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.action).toBe("empty-cleared");
    expect(await e.FILES.head(EMPTYKEY)).toBeNull();
  });

  it("asr-error .empty 不清——重挖照样落空，只会白烧一轮", async () => {
    const e = envWith({
      [EMPTYKEY]: JSON.stringify({ status: "empty", reason: "asr-error:45000151" }),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.action).toBe("empty-kept");
    expect(await e.FILES.head(EMPTYKEY)).not.toBeNull();
  });

  it("多张缺失 → 一次写盘（head 只 +1）、按 key 序补全", async () => {
    const e = envWith({
      [DOCKEY]: v3doc([[{ title: "T", body: "正文。" }]]),
      [`${SCOPE}${REL2}`]: "JPEG",
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const r = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r.missing).toEqual([REL1, REL2]);
    const doc = await readArticleDoc(e, DOCKEY);
    expect(doc.head).toBe(2);
    const body = resolveArticles(doc)[0].body;
    expect(body.indexOf(`[[photo:${REL1}]]`)).toBeLessThan(body.indexOf(`[[photo:${REL2}]]`));
  });

  it("幂等：第二次调用 none-missing，不再铸版本", async () => {
    const e = envWith({
      [DOCKEY]: v3doc([[{ title: "T", body: "正文。" }]]),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    await backfillSessionPhotos(e, SCOPE, TS);
    const r2 = await backfillSessionPhotos(e, SCOPE, TS);
    expect(r2.action).toBe("none-missing");
    expect((await readArticleDoc(e, DOCKEY)).head).toBe(2);
  });

  it("session 没有照片 → no-photos，零写盘", async () => {
    const e = envWith({ [DOCKEY]: v3doc([[{ title: "T", body: "正文。" }]]) });
    expect((await backfillSessionPhotos(e, SCOPE, TS)).action).toBe("no-photos");
    expect((await readArticleDoc(e, DOCKEY)).head).toBe(1);
  });
});

// ── Miner DO：pbf 待办 + alarm min 语义 ────────────────────────────────────────

function fakeDOState() {
  const map = new Map();
  let alarm = null;
  return {
    storage: {
      async get(k) { return map.has(k) ? map.get(k) : undefined; },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async list() { return new Map(map); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
    },
    _alarm: () => alarm,
    _map: map,
  };
}

describe("Miner DO — photoTs poke 与 alarm min 语义", () => {
  it("photoTs poke 写 pbf 待办并把 alarm 设到 +PBF_GRACE_MS", async () => {
    const state = fakeDOState();
    const m = new Miner(state, envWith());
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}&photoTs=${TS}`, { method: "POST" }));
    expect(await state.storage.get(`pbf:${TS}`)).toMatchObject({ tries: 0 });
    expect(state._alarm()).toBeGreaterThan(Date.now() + PBF_GRACE_MS - 5000);
  });

  it("photo alarm 在先，随后的挖矿 poke 把 alarm 提前到 +500ms（min 语义）", async () => {
    const state = fakeDOState();
    const m = new Miner(state, envWith());
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}&photoTs=${TS}`, { method: "POST" }));
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}`, { method: "POST" }));
    expect(state._alarm()).toBeLessThan(Date.now() + 5000);
  });

  it("挖矿 alarm 在先，photo poke 不把它拖后", async () => {
    const state = fakeDOState();
    const m = new Miner(state, envWith());
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}`, { method: "POST" }));
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}&photoTs=${TS}`, { method: "POST" }));
    expect(state._alarm()).toBeLessThan(Date.now() + 5000);
  });

  it("非法 photoTs 不写 pbf 键（防脏 key 常驻 DO storage）", async () => {
    const state = fakeDOState();
    const m = new Miner(state, envWith());
    await m.fetch(new Request(`https://miner/?scope=${encodeURIComponent(SCOPE)}&photoTs=../evil`, { method: "POST" }));
    expect([...state._map.keys()].some((k) => k.startsWith("pbf:"))).toBe(false);
  });

  it("alarm()：成熟的 pbf 待办被补写并清除；未成熟的保留并续约 alarm", async () => {
    const e = envWith({
      [DOCKEY]: v3doc([[{ title: "T", body: "正文。" }]]),
      [`${SCOPE}${REL1}`]: "JPEG",
    });
    const state = fakeDOState();
    await state.storage.put("scope", SCOPE);
    await state.storage.put(`pbf:${TS}`, { at: Date.now() - PBF_GRACE_MS - 1, tries: 0 });      // 成熟
    await state.storage.put("pbf:2026-08-01-130000", { at: Date.now(), tries: 0 });             // 未成熟
    const m = new Miner(state, e);
    await m.alarm();
    expect(await state.storage.get(`pbf:${TS}`)).toBeUndefined();                                // 已处理
    expect(await state.storage.get("pbf:2026-08-01-130000")).toBeDefined();                      // 保留
    expect(state._alarm()).toBeTruthy();                                                         // 续约
    const doc = await readArticleDoc(e, DOCKEY);
    expect(resolveArticles(doc)[0].body).toContain(`[[photo:${REL1}]]`);                         // 真的补了
  });
});

// ── /agent/mine/trigger：photoTs 透传 + admin ?scope= 定向 ─────────────────────

function fakeMinerNS() {
  const pokes = [];
  return {
    pokes,
    idFromName(name) { return { name }; },
    get(id) {
      return { async fetch(req) { pokes.push({ shard: id.name, url: String(req.url) }); return new Response("queued", { status: 202 }); } };
    },
  };
}

describe("/agent/mine/trigger — photoTs 透传", () => {
  it("用户 token + photoTs → poke 自己分片时带上 photoTs", async () => {
    const tok = "anon_0123456789abcdef0123";
    const scope = `users/anon-${(await sha256hex(tok)).slice(0, 32)}/`;
    const e = { ...envWith(), FILES_TOKEN: "admintok" };
    const ns = fakeMinerNS();
    e.Miner = ns;
    const r = await worker.fetch(
      new Request(`https://jianshuo.dev/agent/mine/trigger?photoTs=${TS}`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } }),
      e, { waitUntil() {} },
    );
    expect(r.status).toBe(202);
    expect(ns.pokes[0].shard).toBe("miner:" + scope);
    expect(ns.pokes[0].url).toContain(`photoTs=${TS}`);
  });

  it("admin + ?scope= 定向 poke 该用户分片（补写重放/人工验证）", async () => {
    const e = { ...envWith(), FILES_TOKEN: "admintok" };
    const ns = fakeMinerNS();
    e.Miner = ns;
    await worker.fetch(
      new Request(`https://jianshuo.dev/agent/mine/trigger?scope=${encodeURIComponent(SCOPE)}&photoTs=${TS}`,
        { method: "POST", headers: { Authorization: "Bearer admintok" } }),
      e, { waitUntil() {} },
    );
    expect(ns.pokes[0].shard).toBe("miner:" + SCOPE);
    expect(ns.pokes[0].url).toContain(`photoTs=${TS}`);
  });

  it("admin 不带 scope 照旧踢 sweep dispatcher，photoTs 被忽略", async () => {
    const e = { ...envWith(), FILES_TOKEN: "admintok" };
    const ns = fakeMinerNS();
    e.Miner = ns;
    await worker.fetch(
      new Request(`https://jianshuo.dev/agent/mine/trigger?photoTs=${TS}`, { method: "POST", headers: { Authorization: "Bearer admintok" } }),
      e, { waitUntil() {} },
    );
    expect(ns.pokes[0].shard).toBe("miner");
    expect(ns.pokes[0].url).not.toContain("photoTs");
  });
});

// ── Pages 上传路由：照片 PUT → dispatchMine 带 photoTs（+scope）poke ─────────────

import { onRequest } from "../../functions/files/api/[[path]].js";

function uploadCtx(relPath, { token = "anon_0123456789abcdef0123", contentType = "image/jpeg" } = {}) {
  const segments = ["upload", ...relPath.split("/")];
  const env = { ...fakeEnv(), FILES_TOKEN: "admintok", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: "BYTES",
  });
  return { request, env, params: { path: segments } };
}

describe("Pages 上传路由 — 照片落盘 poke", () => {
  it("照片 PUT → fire-and-forget 调 trigger，URL 带 photoTs 与 scope", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { calls.push(String(url)); return new Response("queued", { status: 202 }); }));
    const c = uploadCtx(`photos/${TS}/3-a1b.jpg`);
    const r = await onRequest(c);
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 0));
    const poke = calls.find((u) => u.includes("/agent/mine/trigger"));
    expect(poke).toBeTruthy();
    expect(poke).toContain(`photoTs=${TS}`);
    expect(decodeURIComponent(poke)).toContain("scope=users/anon-");
  });

  it("非照片上传（.tags 边车）不触发 photo poke", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => { calls.push(String(url)); return new Response("queued", { status: 202 }); }));
    const c = uploadCtx("articles/VoiceDrop-2026-08-01-120000-1m0s-Fri-Aft.tags", { contentType: "application/json" });
    await onRequest(c);
    await new Promise((res) => setTimeout(res, 0));
    expect(calls.some((u) => u.includes("photoTs"))).toBe(false);
  });
});
