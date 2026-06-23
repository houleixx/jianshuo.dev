// VoiceDrop article-editing Agent.
//
// A WebSocket-driven Cloudflare Agent (Durable Object). The app opens
//   wss://jianshuo.dev/agent/edit?stem=<stem>   (Authorization: Bearer <token>)
// and sends {type:"instruct", text}. For each instruction the Agent loads the
// user's article + writing style from R2, asks Claude to rewrite the WHOLE
// document in the owner's voice, writes it back to R2, and pushes the new
// article doc back over the same socket — so the app reloads it in place. The
// connection stays open for an unbounded back-and-forth (per-article history in
// the DO's SQLite gives the agent context across turns).
//
// Auth + scoping mirror the Pages files API (functions/files/api/[[path]].js):
// the same app tokens, the same users/<sub>/ prefix. The DB bucket binding is
// the whole bucket, so every key is derived from the *verified* token, never
// from raw client input.

import { Agent, getAgentByName } from "agents";

const MODEL = "claude-sonnet-4-6";

// Structured-outputs schema — constrains the reply to valid JSON so a large
// prose-heavy CLAUDE.md can't drift the model off clean JSON. GA on sonnet-4-6.
const ARTICLES_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["articles"],
  additionalProperties: false,
};

// Owner-voice DNA — reused from mining/mine.py SYSTEM, reframed for REVISION.
const REVISE_SYSTEM = `你在修改自己已经成文的公众号文章。下面给你：你这段录音的原始口述转写（事实来源）、当前的全部文章、以及历次修改要求。按「这次的修改要求」改写全部文章——可以改写、合并、拆分、增删某一篇。

事实纪律（重要）：
- 只用原始口述转写里出现的事实，绝不编造新的事实、数字、人名、公司名。需要时用「我们公司」。
- 修改要求是「怎么改」，不是新的事实来源；除非要求里明确给了新信息，否则不要往文章里加转写里没有的内容。

每一篇都遵守的语气 DNA：
- 胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
- 不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
- 第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
- 多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
- 细节能列就用表格 / 列表，不在叙述句里堆细节。
- 保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
- 不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。
- 中英文之间留一个空格（盘古之白）。

只输出一个 JSON 对象：{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}，不要输出任何其它文字。`;

// ---------------------------------------------------------------------------
// The Durable Object: one instance per (user, article).
// ---------------------------------------------------------------------------
export class ArticleEditor extends Agent {
  onStart() {
    // config: the verified article key + scope (survives hibernation/eviction).
    this.sql`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`;
    // history: every instruction, for cross-turn context.
    this.sql`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction TEXT,
      created_at INTEGER
    )`;
  }

  // The Worker has already authenticated the request and injected the
  // token-derived article key + scope as headers. Persist them so reconnects
  // (after the DO hibernates) still know which file they own.
  onConnect(connection, ctx) {
    const key = ctx.request.headers.get("x-vd-article-key");
    const scope = ctx.request.headers.get("x-vd-scope");
    if (key && scope) {
      this.sql`INSERT INTO config (k, v) VALUES ('articleKey', ${key})
               ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
      this.sql`INSERT INTO config (k, v) VALUES ('scope', ${scope})
               ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
    }
  }

  _config() {
    const rows = this.sql`SELECT k, v FROM config`;
    const out = {};
    for (const r of rows) out[r.k] = r.v;
    return out;
  }

  async onMessage(connection, message) {
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : ""); }
    catch { return; }
    if (!msg || msg.type !== "instruct") return;
    const instruction = String(msg.text || "").trim();
    if (!instruction) {
      connection.send(JSON.stringify({ type: "error", message: "空指令" }));
      return;
    }
    if (this._busy) {
      connection.send(JSON.stringify({ type: "error", message: "正在修改，请稍候" }));
      return;
    }
    this._busy = true;
    connection.send(JSON.stringify({ type: "status", state: "working" }));
    try {
      const doc = await this._rewrite(instruction);
      connection.send(JSON.stringify({ type: "updated", article: doc }));
    } catch (e) {
      connection.send(JSON.stringify({ type: "error", message: String(e && e.message || e) }));
    } finally {
      this._busy = false;
    }
  }

  async _rewrite(instruction) {
    const { articleKey, scope } = this._config();
    if (!articleKey) throw new Error("会话未初始化");

    const obj = await this.env.FILES.get(articleKey);
    if (!obj) throw new Error("文章不存在");
    const doc = JSON.parse(await obj.text());

    // v1 fallback: a single title/body doc.
    let articles = Array.isArray(doc.articles) ? doc.articles : null;
    if (!articles || !articles.length) {
      if (doc.body) articles = [{ title: doc.title || "(无题)", body: doc.body }];
      else throw new Error("文章没有正文");
    }

    const styleObj = await this.env.FILES.get(scope + "CLAUDE.md");
    const style = styleObj ? (await styleObj.text()).trim() : "";

    const past = this.sql`SELECT instruction FROM history ORDER BY id ASC LIMIT 12`;
    const pastList = past.map((r, i) => `${i + 1}. ${r.instruction}`).join("\n") || "（无）";

    const user = [
      "原始口述转写（事实来源，只能用这里出现的事实，不可编造）：",
      doc.transcript || "（无）",
      "",
      "当前全部文章（JSON）：",
      JSON.stringify({ articles: articles.map((a) => ({ title: a.title, body: a.body })) }, null, 2),
      "",
      "历次修改要求（从旧到新，供参考）：",
      pastList,
      "",
      "这次的修改要求：",
      instruction,
      "",
      '按这次要求改写全部文章，只输出 {"articles":[{"title","body"}]}。',
    ].join("\n");

    const revised = await this._callClaude(style, user);

    // Merge back, preserving the schema and per-article WeChat draft ids by
    // index (drop ids whose index no longer exists).
    const merged = revised.map((a, i) => {
      const out = { title: a.title, body: a.body };
      const prev = articles[i];
      if (prev && prev.wechatMediaId) out.wechatMediaId = prev.wechatMediaId;
      return out;
    });
    doc.articles = merged;
    doc.model = MODEL;
    delete doc.title; delete doc.body;   // collapse any v1 remnants into v2

    await this.env.FILES.put(articleKey, JSON.stringify(doc), {
      httpMetadata: { contentType: "application/json" },
    });

    this.sql`INSERT INTO history (instruction, created_at) VALUES (${instruction}, ${Date.now()})`;
    return doc;
  }

  async _callClaude(style, userContent) {
    const system = style ? `${REVISE_SYSTEM}\n\n---\n\n${style}` : REVISE_SYSTEM;
    const payload = {
      model: MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: ARTICLES_SCHEMA } },
    };
    let articles = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      const data = await resp.json();
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      articles = articlesFrom(text);
      if (articles) break;
    }
    if (!articles) throw new Error("改写结果无法解析");
    if (!articles.length) throw new Error("改写结果为空");
    return articles;
  }
}

// ---------------------------------------------------------------------------
// LLM reply parsing — ported from mine.py _parse_llm_json / _articles_from.
// ---------------------------------------------------------------------------
function parseLLMJson(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```/, "").replace(/```$/, "").trim();
    if (t.slice(0, 4).toLowerCase() === "json") t = t.slice(4).trimStart();
  }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

function articlesFrom(text) {
  let obj;
  try { obj = parseLLMJson(text); } catch { return null; }
  const arts = Array.isArray(obj) ? obj : (obj && obj.articles);
  if (!Array.isArray(arts)) return [];
  return arts
    .filter((a) => a && typeof a === "object" && String(a.body || "").trim())
    .map((a) => ({ title: String(a.title || "(无题)").trim(), body: String(a.body).trim() }));
}

// ---------------------------------------------------------------------------
// StatusHub: per-user Durable Object that brokers real-time status pushes.
// The app connects via WebSocket (/agent/status); mine.py POSTs to
// /agent/notify (authenticated with FILES_TOKEN) when a recording changes
// state. The hub broadcasts to all connected app sockets for that user.
// Uses WebSocket Hibernation so idle hubs cost nothing.
// ---------------------------------------------------------------------------
export class StatusHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const body = await request.json();
      const msg = JSON.stringify({ type: "status_update", stem: body.stem, status: body.status });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(msg); } catch (_) {}
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  webSocketMessage(_ws, _msg) {}
  webSocketClose(_ws) {}
  webSocketError(_ws) {}
}

// ---------------------------------------------------------------------------
// Worker entry: authenticate, then route the WS upgrade to the right DO.
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /agent/edit ── existing article-editing agent ──────────────────────
    if (url.pathname === "/agent/edit") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });

      const stem = url.searchParams.get("stem") || "";
      if (!stem || stem.startsWith("/") || stem.split("/").some((s) => s === ".." || s === "")) {
        return new Response("bad stem", { status: 400 });
      }
      const articleKey = `${scope}articles/${stem}.json`;
      const name = sanitizeName(scope + stem);

      const agent = await getAgentByName(env.ArticleEditor, name);
      const fwd = new Request(request);
      fwd.headers.set("x-vd-article-key", articleKey);
      fwd.headers.set("x-vd-scope", scope);
      return agent.fetch(fwd);
    }

    // ── /agent/status ── app WebSocket for real-time status updates ─────────
    if (url.pathname === "/agent/status") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });

      const id = env.StatusHub.idFromName("status:" + scope);
      const stub = env.StatusHub.get(id);
      return stub.fetch(request);
    }

    // ── /agent/notify ── mine.py notifies about processing state ───────────
    if (url.pathname === "/agent/notify") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const adminToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.FILES_TOKEN || adminToken !== env.FILES_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const { user_scope, stem, status } = await request.json();
      if (!user_scope || !stem || !status) return new Response("bad request", { status: 400 });

      const id = env.StatusHub.idFromName("status:" + user_scope);
      const stub = env.StatusHub.get(id);
      return stub.fetch(new Request("https://status-hub/broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stem, status }),
      }));
    }

    return new Response("not found", { status: 404 });
  },
};

// Resolve a writable scope from an app token. Read-only temp tokens are rejected
// (editing requires write). Returns 'users/<sub>/' or null.
async function resolveScope(token, env) {
  if (!token) return null;
  if (env.FILES_TOKEN && token === env.FILES_TOKEN) return null; // admin has no single scope here
  if (env.SESSION_SECRET) {
    const sess = await verifySession(token, env.SESSION_SECRET);
    if (sess) return sess.scope;
  }
  if (token.startsWith("anon_") && token.length >= 20) {
    const id = (await sha256hex(token)).slice(0, 32);
    return `users/anon-${id}/`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth + crypto helpers — ported verbatim from functions/files/api/[[path]].js.
// ---------------------------------------------------------------------------
async function verifySession(tokenStr, secret) {
  const parts = tokenStr.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (!timingSafeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  if (!payload.scope) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return { scope: payload.scope, apple: !!payload.apple };
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

function sanitizeSeg(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, "_"); }
function sanitizeName(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200); }

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }
