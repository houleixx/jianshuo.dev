// Per-user miner sharding: uploads kick the uploader's OWN Miner DO shard
// (idFromName "miner:<scope>", mines only that user's prefix) so one user's
// long recording no longer queues everyone else. The legacy singleton
// (idFromName "miner") is now the sweep dispatcher — cron/admin trigger it, it
// lists the whole bucket once and pokes every shard that still has work.
import { describe, it, expect, vi, afterEach } from "vitest";
// vi.mock is hoisted before static imports — keeps the real `agents` package
// (which imports cloudflare:email / cloudflare:workers) out of the test runtime.
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { runMine, scopesWithWork } from "../src/miner.js";
import worker, { Miner } from "../src/index.js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

function env(seed = {}, secrets = { CLAUDE_API_KEY: "sk-ant" }) {
  return { ...fakeEnv(seed), ...secrets };
}

function resp(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => "" } };
}

const llmFetch = () => vi.fn(async (url, init) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    return resp({ content: [{ type: "text", text: JSON.stringify({ articles: [{ title: "标题", body: "正文" }] }) }] });
  }
  if (u.includes("/files/api/")) return resp({ ok: true });
  return resp({ error: "no route" }, { ok: false, status: 404 });
});

const U1_TEXT = "这是用户一分享进来的一段足够长的文字，可以挖成一篇公众号文章，聊聊今天的想法。";
const U2_TEXT = "这是用户二分享进来的另一段足够长的文字，同样可以挖成一篇公众号文章，说说别的。";

// Minimal Durable Object state mock: storage map + alarm slot.
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
  };
}

// Minimal DO namespace mock recording which shards get poked.
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("scopesWithWork — whole-bucket sweep groups unprocessed work by user", () => {
  it("returns only scopes that still have work", async () => {
    const e = env({
      "users/u1/VoiceDrop-mine-1718000000.txt": U1_TEXT,                       // unprocessed text
      "users/u2/VoiceDrop-2026-06-26-120000-30-fri-am.m4a": "AUDIO",           // unprocessed audio
      "users/u3/VoiceDrop-mine-1718000001.txt": "已处理",                       // processed (marker below)
      "users/u3/articles/VoiceDrop-mine-1718000001.json": "{}",
    });
    const scopes = await scopesWithWork(e);
    expect(scopes.sort()).toEqual(["users/u1/", "users/u2/"]);
  });
});

describe("runMine(env, scope) — a shard mines ONLY its own user's prefix", () => {
  it("mines u1's text and never touches u2's", async () => {
    const fetchSpy = llmFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const e = env({
      "users/u1/VoiceDrop-mine-1718000000.txt": U1_TEXT,
      "users/u2/VoiceDrop-mine-1718000000.txt": U2_TEXT,
    });
    await runMine(e, "users/u1/");
    const puts = fetchSpy.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([u]) => String(u));
    expect(puts.some((u) => u.includes("/articles/u1/"))).toBe(true);
    expect(puts.some((u) => u.includes("/articles/u2/"))).toBe(false);
  });
});

describe("Miner DO — shard remembers its scope and mines it on alarm", () => {
  it("fetch(?scope=…) stores the scope and arms the alarm", async () => {
    const state = fakeDOState();
    const m = new Miner(state, env());
    const r = await m.fetch(new Request("https://miner/?scope=" + encodeURIComponent("users/u1/"), { method: "POST" }));
    expect(r.status).toBe(202);
    expect(await state.storage.get("scope")).toBe("users/u1/");
    expect(state._alarm()).toBeTruthy();
  });

  it("alarm() on a shard mines that scope only", async () => {
    const fetchSpy = llmFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const e = env({
      "users/u1/VoiceDrop-mine-1718000000.txt": U1_TEXT,
      "users/u2/VoiceDrop-mine-1718000000.txt": U2_TEXT,
    });
    const state = fakeDOState();
    await state.storage.put("scope", "users/u1/");
    const m = new Miner(state, e);
    await m.alarm();
    const puts = fetchSpy.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([u]) => String(u));
    expect(puts.some((u) => u.includes("/articles/u1/"))).toBe(true);
    expect(puts.some((u) => u.includes("/articles/u2/"))).toBe(false);
  });

  it("alarm() on the scopeless singleton dispatches shards instead of mining", async () => {
    const e = env({
      "users/u1/VoiceDrop-mine-1718000000.txt": U1_TEXT,
      "users/u2/VoiceDrop-2026-06-26-120000-30-fri-am.m4a": "AUDIO",
    });
    const ns = fakeMinerNS();
    e.Miner = ns;
    const fetchSpy = vi.fn(async () => { throw new Error("dispatcher must not call LLM/ASR"); });
    vi.stubGlobal("fetch", fetchSpy);
    const state = fakeDOState(); // no "scope" key = singleton
    const m = new Miner(state, e);
    await m.alarm();
    expect(ns.pokes.map((p) => p.shard).sort()).toEqual(["miner:users/u1/", "miner:users/u2/"]);
    expect(ns.pokes.every((p) => p.url.includes("scope="))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/agent/mine/trigger — routes callers to the right shard", () => {
  it("a user token kicks that user's own shard", async () => {
    const tok = "anon_0123456789abcdef0123";
    const scope = `users/anon-${(await sha256hex(tok)).slice(0, 32)}/`;
    const e = { ...env(), FILES_TOKEN: "admintok" };
    const ns = fakeMinerNS();
    e.Miner = ns;
    const r = await worker.fetch(
      new Request("https://jianshuo.dev/agent/mine/trigger", { method: "POST", headers: { Authorization: `Bearer ${tok}` } }),
      e,
      { waitUntil() {} },
    );
    expect(r.status).toBe(202);
    expect(ns.pokes).toHaveLength(1);
    expect(ns.pokes[0].shard).toBe("miner:" + scope);
    expect(decodeURIComponent(ns.pokes[0].url)).toContain("scope=" + scope);
  });

  it("the admin token kicks the sweep dispatcher singleton", async () => {
    const e = { ...env(), FILES_TOKEN: "admintok" };
    const ns = fakeMinerNS();
    e.Miner = ns;
    const r = await worker.fetch(
      new Request("https://jianshuo.dev/agent/mine/trigger", { method: "POST", headers: { Authorization: "Bearer admintok" } }),
      e,
      { waitUntil() {} },
    );
    expect(r.status).toBe(202);
    expect(ns.pokes).toHaveLength(1);
    expect(ns.pokes[0].shard).toBe("miner");
    expect(ns.pokes[0].url).not.toContain("scope=");
  });
});
