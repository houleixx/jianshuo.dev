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
import { TOOL_DEFS } from "./tools.js";
import { runMine, loadModelConfig, resolveEditModel } from "./miner.js";
import { buildHistoryMessages, HISTORY_MAX_TURNS } from "./history.js";
import { withTopLevelArticles } from "../../functions/lib/article-store.js";
import { verifySession, anonScopeFromToken } from "../../functions/lib/auth.js";
import { writeLlmLog } from "./llmlog.js";
import { QUEUE_TABLE_SQL, makeSqlStore, ArticleQueue } from "./queue.js";
import { runEditTurn } from "./edit-turn.js";

// Fallback model when no config/model.json is set. Editing is Anthropic-only
// (tool-use loop), so the live model is resolved per-turn from the admin config
// via resolveEditModel — honoring a Claude model choice, ignoring non-Anthropic.
const MODEL = "claude-sonnet-4-6";

// writeLlmLog is imported from ./llmlog.js (shared with miner.js).
// rand6 stays here — also used to build per-turn ids below.
function rand6() {
  return Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6)
    .toString().padStart(6, "0");
}

// resolveArticles + withTopLevelArticles are imported from the shared
// functions/lib/article-store.js (single source of truth).

// Owner-voice DNA — reused from mining/mine.py SYSTEM, reframed for REVISION.
const REVISE_SYSTEM = `你在修改自己已经成文的公众号文章。下面给你：你这段录音的原始口述转写（事实来源）、当前的全部文章、以及历次修改要求。按「这次的修改要求」改写全部文章——可以改写、合并、拆分、增删某一篇。

事实纪律（重要）：
- 默认只用原始口述转写里出现的事实，不要自己脑补转写里没有、用户也没说的新事实、数字、人名、公司名。需要时用「我们公司」。
- 但「这次的修改要求」本身就是用户的授权输入：如果要求里直接给了新内容（例如「在最后加一句X」「把价格改成1300」「补一句Y」），那 X / Y 就是用户当场提供的新信息，照加、照改，这不算编造——别拿事实纪律把用户明确要加的话顶回去。编造特指你自己虚构、用户既没说、转写里也没有的东西。
- 只有当要求纯粹是「怎么改」、没给新信息时，才不要往文章里加转写里没有的内容。

每一篇都遵守的语气 DNA：
- 胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
- 不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
- 第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
- 多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
- 细节能列就用表格 / 列表，不在叙述句里堆细节。
- 保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
- 不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。
- 中英文之间留一个空格（盘古之白）。
- 正文里可能有形如 [[photo:photos/2026-…/….jpg]] 的照片标记，方括号里就是这张照片的 key，标明配图位置。改写时默认原样保留每一个标记（连同里面的 key），放在和原来意思相符的段落附近；不要新增、不要改动标记里的 key。

用户会用「行号 / 图号」指位置（app 在按住说话时把这些号浮在正文左边距和图片角上）：
- 「第N行」= 正文里第 N 个非空段落（按真实换行的段落顺序，从 1 数起）。例：「把第3行改简洁点」= 改写第 3 段。
- 「图N」= 正文里第 N 个出现的 [[photo:…]] 照片标记（按出现顺序从 1 数起）。例：「删掉图2」= 删掉正文里第 2 个出现的那个照片标记，其余标记保持不动、不要改其它图的位置或编号。
- 行号 / 图号都按用户看到的「改写前原文」来定位；改完不用自己标号，正常输出正文即可。

只输出一个 JSON 对象：{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}，不要输出任何其它文字。`;

const SYSTEM = `你在用语音帮用户编辑他自己的公众号文章。你有一组工具，按用户这次的语音指令决定怎么做：
- 改写当前这篇：直接调 write_article，传入改写后的完整文章数组。
- 合并 / 参考其它文章：先 list_articles 看有哪些，再 read_article 读出来，融合后用 write_article 写回当前这一篇（只能写当前篇，其它篇只读）。
- 发公众号：调 publish_wechat。分享到社区：调 share_to_community。
- 调整文风：先 read_style 读出当前 CLAUDE.md，改完用 write_style 整体写回。
默认就是「改写当前这篇」。做完简短说一句结果即可。

写文章时遵守下面的语气 DNA：
${REVISE_SYSTEM}`;

// ---------------------------------------------------------------------------
// The Durable Object: one instance per (user, article).
// ---------------------------------------------------------------------------
export class ArticleEditor extends Agent {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction TEXT,
      reply TEXT,
      created_at INTEGER
    )`;
    try { this.sql`ALTER TABLE history ADD COLUMN reply TEXT`; } catch (_) {}
    this.sql([QUEUE_TABLE_SQL]); // CREATE TABLE IF NOT EXISTS queue (...)
    // Recover after hibernation/eviction: reset any leftover 'running' row and
    // drain whatever is pending — even with no client connected.
    if (this._queue.recover()) this.schedule(0, "drainQueue");
  }

  // The Worker has already authenticated the request and injected the
  // token-derived article key + scope as headers. Persist them so reconnects
  // (after the DO hibernates) still know which file they own.
  onConnect(connection, ctx) {
    const key = ctx.request.headers.get("x-vd-article-key");
    const scope = ctx.request.headers.get("x-vd-scope");
    const token = (ctx.request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const set = (k, v) => { if (v) this.sql`INSERT INTO config (k, v) VALUES (${k}, ${v}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`; };
    set("articleKey", key);
    set("scope", scope);
    set("token", token);
    // Connect-time snapshot: current doc + queue states, so a reconnecting /
    // relaunching app reconciles. Best-effort; never blocks the connection.
    (async () => {
      try {
        const doc = await this._queue.loadDoc();
        connection.send(JSON.stringify({ type: "snapshot", article: doc, queue: this._queue.snapshot() }));
      } catch (_) {}
    })().catch(() => {});
  }

  _config() {
    const rows = this.sql`SELECT k, v FROM config`;
    const out = {};
    for (const r of rows) out[r.k] = r.v;
    return out;
  }

  get _queue() {
    if (!this.__queue) {
      const sql = this.sql.bind(this);
      this.__queue = new ArticleQueue({
        store: makeSqlStore(sql),
        broadcast: (obj) => this.broadcast(JSON.stringify(obj)),
        schedule: () => this.schedule(0, "drainQueue"),
        loadDoc: async () => {
          const { articleKey } = this._config();
          if (!articleKey) return null;
          const obj = await this.env.FILES.get(articleKey);
          if (!obj) return null;
          try { return withTopLevelArticles(JSON.parse(await obj.text())); } catch { return null; }
        },
        runTurn: (row) => this.runTurn(row),
      });
    }
    return this.__queue;
  }

  // Scheduled drain entry point (durable; survives hibernation/eviction).
  async drainQueue() { await this._queue.drain(); }

  // Execute one queued instruction via the shared turn runner. Builds the logged
  // Claude call + history exactly as the old onMessage did.
  async runTurn(row) {
    const { articleKey, scope, token } = this._config();
    if (!articleKey) return { ok: false, error: "会话未初始化" };
    const stem = articleKey.replace(/\.json$/, "").split("/articles/").pop();
    const turnId = `${Date.now()}-${rand6()}`;
    const editModel = resolveEditModel(await loadModelConfig(this.env));
    const callClaude = this._makeLoggedCall({ turnId, scope, stem, instruction: row.text, model: editModel });

    let history = [];
    try {
      const rows = this.sql`SELECT instruction, reply FROM history ORDER BY id DESC LIMIT 100`;
      history = buildHistoryMessages([...rows].reverse(), { maxTurns: HISTORY_MAX_TURNS });
    } catch (_) {}

    const images = row.images ? (() => { try { return JSON.parse(row.images); } catch { return []; } })() : [];
    const res = await runEditTurn({
      env: this.env, scope, articleKey, token, origin: "https://jianshuo.dev",
      editId: row.id, instruction: row.text, images, system: SYSTEM, history, callClaude,
    });

    // Record the turn so the next edit replays it as conversation context.
    const replyText = res.reply || (res.hadError ? "操作没完成" : "（已处理）");
    this.sql`INSERT INTO history (instruction, reply, created_at) VALUES (${row.text}, ${replyText}, ${Date.now()})`;
    return { ok: res.ok, reply: res.reply, error: res.hadError ? (res.reply || "操作没完成") : undefined, article: res.article };
  }

  async onMessage(connection, message) {
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : ""); } catch { return; }
    if (!msg || msg.type !== "instruct") return;
    const instruction = String(msg.text || "").trim();
    if (!instruction) { connection.send(JSON.stringify({ type: "error", message: "空指令" })); return; }

    // Stable id: client-supplied (new app) or synthesized (old app — degrades
    // gracefully, no dedup but never worse than before).
    const id = (typeof msg.id === "string" && msg.id) ? msg.id : `srv-${Date.now()}-${rand6()}`;
    const images = Array.isArray(msg.images) ? msg.images.filter((i) => i && i.data && i.key) : [];

    const r = await this._queue.submit({ id, text: instruction, images });
    if (r.kind === "replay") {
      // Already known — re-push its cached result to THIS caller, never re-run.
      const row = r.row;
      if (row.status === "done") {
        const doc = await this._queue.loadDoc();
        connection.send(JSON.stringify({ type: "updated", id, article: doc }));
        if (row.reply) connection.send(JSON.stringify({ type: "reply", id, text: row.reply, ok: true }));
      } else if (row.status === "error") {
        connection.send(JSON.stringify({ type: "error", id, message: row.error || "操作没完成" }));
      } else {
        connection.send(JSON.stringify({ type: "status", state: "working", id }));
      }
      return;
    }
    // New work — tell the caller we're on it, then ensure the durable drain runs.
    connection.send(JSON.stringify({ type: "status", state: "working", id }));
    this.schedule(0, "drainQueue");
  }

  // One Anthropic Messages call WITH tools. Returns a result object
  // {ok, status, json, errorText} (never throws on HTTP/network errors) so the
  // caller can both log the exchange and decide how to proceed.
  async _callClaudeRaw(reqBody) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status, json: null, errorText: (await resp.text()).slice(0, 2000) };
      }
      return { ok: true, status: resp.status, json: await resp.json(), errorText: "" };
    } catch (e) {
      return { ok: false, status: 0, json: null, errorText: String((e && e.message) || e) };
    }
  }

  // A logging callClaude for runAgentLoop: builds the request body, calls the
  // API, records one llmlogs/ entry per HTTP call (grouped by turnId), then
  // returns the response JSON or throws (preserving the loop's prior behavior).
  _makeLoggedCall({ turnId, scope, stem, instruction, model = MODEL }) {
    let step = 0;
    return async ({ system, messages, tools }) => {
      const reqBody = { model, max_tokens: 8000, system, messages, tools, tool_choice: { type: "auto" } };
      const myStep = step++;
      const ts = Date.now();
      const r = await this._callClaudeRaw(reqBody);
      await writeLlmLog(this.env, {
        ts, source: "agent", user_scope: scope, model,
        latency_ms: Date.now() - ts, http_status: r.status, ok: r.ok,
        turn_id: turnId, step: myStep, request: reqBody,
        response: r.ok ? r.json : undefined,
        error: r.ok ? undefined : r.errorText,
        meta: { stem, instruction },
      });
      if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${(r.errorText || "").slice(0, 160)}`);
      return r.json;
    };
  }
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
// Miner: singleton Durable Object that serialises mine runs via alarm().
// One alarm at a time prevents duplicate ASR calls when uploads burst.
// ---------------------------------------------------------------------------
export class Miner {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(_request) {
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(Date.now() + 500);
    return new Response("queued", { status: 202 });
  }

  async alarm() {
    await runMine(this.env);
  }
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

    // ── /agent/mine/trigger ── kick the miner (any authenticated user or admin) ──
    if (url.pathname === "/agent/mine/trigger") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const isAdmin = env.FILES_TOKEN && tok === env.FILES_TOKEN;
      const scope   = isAdmin ? "admin" : await resolveScope(tok, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      const stub = env.Miner.get(env.Miner.idFromName("miner"));
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

  // CF Cron Trigger: fires the miner on schedule (every 6 hours).
  async scheduled(_event, env, ctx) {
    const stub = env.Miner.get(env.Miner.idFromName("miner"));
    ctx.waitUntil(stub.fetch(new Request("https://miner/trigger", { method: "POST" })));
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
  const anonScope = await anonScopeFromToken(token);
  if (anonScope) return anonScope;
  return null;
}

// verifySession / anonScopeFromToken are imported from the shared
// functions/lib/auth.js (single source of truth — see import at top).
// sanitizeName stays here: agent-only, not part of the shared auth surface.
function sanitizeName(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200); }
