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
import { runMine, loadModelConfig, resolveEditModel, MINE_RESUME_MS } from "./miner.js";
import { buildHistoryMessages, HISTORY_MAX_TURNS } from "./history.js";
import { withTopLevelArticles } from "../../functions/lib/article-store.js";
import { verifySession, anonScopeFromToken } from "../../functions/lib/auth.js";
import { buildBroadcastMessage, createPairing, verifyPairing, completePairing, resolveMatchingScopes, genDistinctCodes, CODE_TTL_MS } from "./devicelink.js";
import { writeLlmLog } from "./llmlog.js";
import { QUEUE_TABLE_SQL, makeSqlStore, ArticleQueue } from "./queue.js";
import { runEditTurn } from "./edit-turn.js";
import { proxyVolcAsrWebSocket } from "./asr-proxy.js";
import { editGate, claudeCostUY, uyToSuanli, uyToYuan, suanliToUY } from "./usage.js";
import { ensureAccount, debit, editCount, getLedger, grant, allAccounts } from "./usage_store.js";

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

// meteredEditGate — exported so test/usage_edit.test.js can unit-test it.
// Fail-open: if USAGE is undefined (env binding absent), returns "ok".
export async function meteredEditGate(db, scope, stem, now) {
  if (!db) return "ok";
  try {
    const bal = await ensureAccount(db, scope, now);
    const edits = await editCount(db, scope, stem);
    return editGate(bal, edits);
  } catch { return "ok"; }
}

// resolveArticles + withTopLevelArticles are imported from the shared
// functions/lib/article-store.js (single source of truth).

// Owner-voice DNA — reused from mining/mine.py SYSTEM, reframed for REVISION.
const REVISE_SYSTEM = `你在修改自己已经成文的公众号文章。下面给你：你这段录音的原始口述转写（事实来源）、当前的全部文章、以及历次修改要求。按「这次的修改要求」改写全部文章——可以改写、合并、拆分、增删某一篇。

事实来源（编辑场景，重要）：
- 「这次的修改要求」就是最高事实来源——用户当场说的就是事实。他让你加 / 改的任何内容（数字、价格、人名、公司名、一句话，例如「加一句花了2430」「把价格改成1300」「结尾补一句X」），一律照加照改，直接当成用户提供的真实信息。**绝不反问、绝不要求确认、绝不拿「原始转写里没有」当理由顶回去。**
- 原始口述转写只是底稿参考，不是限制用户的边界。用户这次说的和转写不一致时，以用户这次说的为准。
- 唯一底线：不要自己凭空虚构用户根本没说、也没让你加的东西。只要是用户这次明确说出来的，就照办，别犹豫。

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

用户会用「行号 / 图号」指位置（app 在按住说话时把这些号浮在正文左边距和图片角上）。下面用户消息里的「当前文章」正文就是逐行标好号的版本——每行开头的「第N行 / 图M」就是用户此刻屏幕上看到的号，请严格按这个号定位，不要自己重新数行：
- 「第N行」= 正文里标着「第N行」的那一行（正文按真实换行拆出的第 N 个非空行；照片标记 [[photo:…]] 自己单独成行，也占一个行号，所以行号会跨过图片连续往后累加）。例：「把第3行改简洁点」= 改写正文里第 3 行那段。
- 「图N」= 第 N 个 [[photo:…]] 照片标记；同一张图在正文里既标「第N行」也标「图N」，两种说法都指向它。例：「删掉图2」= 删掉第 2 个照片标记，其余标记和别的图号都不动。
- 一律按用户看到的带号正文定位；这些号只是定位用、不属于正文，改完正文里不要写行号 / 图号，正常输出，[[photo:…]] 标记原样保留。

绝大多数语音指令都是对当前这篇做定点小改（删一行、改一行、删图、插一段、改标题）——这种一律用 edit_current_article，只描述这次的改动（行号就用当前文章里标的第N行），绝不要回传整篇正文。只有当这次要把多篇合并、参考别的文章重写、或对当前篇做伤筋动骨的大重构时，才用 write_article 回传完整文章数组。无论用哪个，都绝不要把 JSON 或正文直接贴进聊天回复——回复里只简略的把做了什么告诉用户就好。`;

const SYSTEM = `你在用语音帮用户编辑他自己的公众号文章。你有一组工具，按用户这次的语音指令决定怎么做：
- 定点修改当前这篇（删行 / 改一行 / 删图 / 插一段 / 改标题）：调 edit_current_article，只描述这次的改动，不要回传全文。这是默认路径，绝大多数指令都走这里。
- 大改 / 合并 / 参考其它文章：先 list_articles 看有哪些，再 read_article 读出来，融合后用 write_article 把完整文章数组写回当前这一篇（只能写当前篇，其它篇只读）。
- 发公众号：调 publish_wechat。分享到社区：调 share_to_community。
- 调整文风：先 read_style 读出当前 CLAUDE.md，改完用 write_style 整体写回。
默认就是用 edit_current_article 定点改当前这篇。做完简短说一句结果即可。

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
    // Migrate queue rows created before article_index existed (locator targeting).
    try { this.sql`ALTER TABLE queue ADD COLUMN article_index INTEGER`; } catch (_) {}
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

    // Usage gate: check balance + per-article edit cap before spending any tokens.
    const decision = await meteredEditGate(this.env.USAGE, scope, stem, Date.now());
    if (decision === "no-credit") return { ok: false, error: "算力不足，无法继续编辑" };
    if (decision === "limit") return { ok: false, error: "这篇已达编辑上限（100 次）" };

    const turnId = `${Date.now()}-${rand6()}`;
    const editModel = resolveEditModel(await loadModelConfig(this.env));
    const callClaude = this._makeLoggedCall({ turnId, scope, stem, instruction: row.text, model: editModel });

    let history = [];
    try {
      const rows = this.sql`SELECT instruction, reply FROM history ORDER BY id DESC LIMIT 100`;
      history = buildHistoryMessages([...rows].reverse(), { maxTurns: HISTORY_MAX_TURNS });
    } catch (_) {}

    const images = row.images ? (() => { try { return JSON.parse(row.images); } catch { return []; } })() : [];
    const articleIndex = Number.isInteger(row.article_index) ? row.article_index : 0;
    const res = await runEditTurn({
      env: this.env, scope, articleKey, token, origin: "https://jianshuo.dev",
      editId: row.id, instruction: row.text, images, articleIndex, system: SYSTEM, history, callClaude,
    });

    // Log this turn's tool executions (name + input + result) — the terminal
    // short-circuit means a successful edit/write/publish never reaches another
    // logged Claude call, so this is the ONLY record of what the instruction did.
    // Same turn_id as the LLM steps so the admin shows it under the same turn.
    if (res.toolRuns && res.toolRuns.length) {
      await writeLlmLog(this.env, {
        ts: Date.now(), source: "agent", user_scope: scope, model: editModel,
        kind: "tool_runs", turn_id: turnId, step: 900,
        ok: res.toolRuns.every((t) => t.ok), tool_runs: res.toolRuns,
        meta: { stem, instruction: row.text },
      });
    }

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
    // Which article the user is looking at — so the locator table numbers THAT one
    // (multi-article docs renumber 第1行 per article). Old apps omit it → 0.
    const article_index = Number.isInteger(msg.articleIndex) && msg.articleIndex >= 0 ? msg.articleIndex : 0;

    const r = await this._queue.submit({ id, text: instruction, images, article_index });
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
      // Debit the cost of this API call. Best-effort: never breaks the edit.
      try {
        if (this.env.USAGE) {
          const u = r.json?.usage || {};
          await debit(this.env.USAGE, scope, claudeCostUY(model, u.input_tokens, u.output_tokens),
            "edit", { model, in_tok: u.input_tokens, out_tok: u.output_tokens, stem, turn_id: turnId }, Date.now());
        }
      } catch {}
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
      const msg = JSON.stringify(buildBroadcastMessage(body));
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
    // runMine processes a bounded slice (subrequest budget) and tells us if ASR is
    // still cooking or work was deferred — if so, come back soon to resume so long
    // audio finishes across passes instead of timing out in one invocation.
    const r = await runMine(this.env);
    if (r && r.moreWork) await this.state.storage.setAlarm(Date.now() + MINE_RESUME_MS);
  }
}

// ---------------------------------------------------------------------------
// LinkBroker: per-pairing Durable Object (idFromName(pairingId)). Holds the
// pairing state and the NEW device's wait-socket. Self-expires via alarm().
// All decision logic lives in devicelink.js — this is a thin shell.
// ---------------------------------------------------------------------------
export class LinkBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    // New device's wait-socket.
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      const s = await this.state.storage.get("pairing");
      if (s && s.blob) { try { server.send(JSON.stringify({ type: "link_ready", blob: s.blob })); } catch (_) {} }
      return new Response(null, { status: 101, webSocket: client });
    }

    const body = await request.json().catch(() => ({}));
    const now = Date.now();

    if (body.op === "create") {
      const s = createPairing({ pubkey: body.pubkey, entries: body.entries, now, ttlMs: CODE_TTL_MS });
      await this.state.storage.put("pairing", s);
      await this.state.storage.setAlarm(now + CODE_TTL_MS);
      return Response.json({ ok: true });
    }

    const s = await this.state.storage.get("pairing");
    if (!s) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

    if (body.op === "verify") {
      const { state, result } = verifyPairing(s, body.code, now);
      await this.state.storage.put("pairing", state);
      return Response.json(result);
    }

    if (body.op === "complete") {
      const { state, result } = completePairing(s, body.callerScope, body.blob, now);
      await this.state.storage.put("pairing", state);
      if (result.ok) {
        await this.state.storage.deleteAlarm();
        for (const ws of this.state.getWebSockets()) {
          try { ws.send(JSON.stringify({ type: "link_ready", blob: state.blob })); } catch (_) {}
        }
      }
      return Response.json(result, { status: result.ok ? 200 : 403 });
    }

    if (body.op === "cancel") {
      if (!s.entries.some((e) => e.scope === body.callerScope)) {
        return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      }
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(JSON.stringify({ type: "link_cancelled" })); } catch (_) {}
      }
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete("pairing");
      return Response.json({ ok: true });
    }

    return new Response("bad op", { status: 400 });
  }

  async alarm() {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "link_expired" })); } catch (_) {}
    }
    await this.state.storage.delete("pairing");
  }

  webSocketMessage(_ws, _msg) {}
  webSocketClose(_ws) {}
  webSocketError(_ws) {}
}

// ---------------------------------------------------------------------------
// Usage route helpers
// ---------------------------------------------------------------------------
const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const bearer = (req) => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export async function handleUsageRoute(url, request, env) {
  if (!url.pathname.startsWith("/agent/usage/")) return null;
  try {
  const tok = bearer(request);
  const isAdmin = env.FILES_TOKEN && tok === env.FILES_TOKEN;

  if (url.pathname === "/agent/usage/balance" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ suanli: 0, yuan: 0, granted_suanli: 0, spent_suanli: 0, degraded: true });
    await ensureAccount(env.USAGE, scope, Date.now());
    const a = await env.USAGE.prepare("SELECT balance_uy,granted_uy,spent_uy FROM account WHERE user_sub=?").bind(scope).first();
    return J({ suanli: r1(uyToSuanli(a.balance_uy)), yuan: r2(uyToYuan(a.balance_uy)),
      granted_suanli: r1(uyToSuanli(a.granted_uy)), spent_suanli: r1(uyToSuanli(a.spent_uy)) });
  }

  if (url.pathname === "/agent/usage/ledger" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ entries: [], degraded: true });
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    const rows = await getLedger(env.USAGE, scope, limit);
    return J({ entries: rows.map((e) => ({ ts: e.ts, kind: e.kind, reason: e.reason,
      suanli: r1(uyToSuanli(e.amount_uy)), yuan: r2(uyToYuan(e.amount_uy)),
      balance_suanli: r1(uyToSuanli(e.balance_uy)), detail: e.detail ? JSON.parse(e.detail) : null })) });
  }

  if (url.pathname === "/agent/usage/grant" && request.method === "POST") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.user_sub || typeof b.suanli !== "number") return J({ error: "bad-request" }, 400);
    await grant(env.USAGE, b.user_sub, suanliToUY(b.suanli), "campaign:" + (b.reason || "manual"), Date.now());
    return J({ ok: true });
  }

  if (url.pathname === "/agent/usage/admin/accounts" && request.method === "GET") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const rows = await allAccounts(env.USAGE);
    return J({ accounts: rows.map((a) => ({ user_sub: a.user_sub,
      balance_suanli: r1(uyToSuanli(a.balance_uy)), granted_suanli: r1(uyToSuanli(a.granted_uy)),
      spent_suanli: r1(uyToSuanli(a.spent_uy)), spent_yuan: r2(uyToYuan(a.spent_uy)) })) });
  }

  return J({ error: "not-found" }, 404);
  } catch (_) {
    return J({ error: "usage-unavailable", degraded: true }, 200);
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

    // ── /agent/asr ── authenticated WebSocket proxy for Volc streaming ASR ──
    if (url.pathname === "/agent/asr") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const auth = request.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });

      return proxyVolcAsrWebSocket(request, env);
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

    // ── /agent/link/* ── device-link pairing (new device logs into old account) ──
    if (url.pathname === "/agent/link/start") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await resolveScope(tok, env))) return new Response("unauthorized", { status: 401 });
      const { prefix, pubkey } = await request.json().catch(() => ({}));
      if (!/^[0-9a-fA-F]{6}$/.test(prefix || "") || !pubkey) return new Response("bad request", { status: 400 });
      const scopes = await resolveMatchingScopes(env, prefix);
      if (scopes.length === 0) return Response.json({ ok: false, reason: "no_match" });
      const codes = genDistinctCodes(scopes.length);
      const entries = scopes.map((scope, i) => ({ scope, code: codes[i] }));
      const pairingId = randomId();
      const broker = env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));
      await broker.fetch(new Request("https://link/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create", pubkey, entries }),
      }));
      for (const { scope, code } of entries) {
        const hub = env.StatusHub.get(env.StatusHub.idFromName("status:" + scope));
        await hub.fetch(new Request("https://status-hub/broadcast", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: { type: "link_request", pairingId, code, pubkey } }),
        }));
      }
      return Response.json({ ok: true, pairingId, matchCount: scopes.length });
    }

    if (url.pathname === "/agent/link/socket") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pairingId = url.searchParams.get("pairingId") || "";
      if (!/^[0-9a-f]{32}$/.test(pairingId)) return new Response("bad request", { status: 400 });
      const broker = env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));
      return broker.fetch(request);
    }

    if (url.pathname === "/agent/link/verify") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!(await resolveScope(tok, env))) return new Response("unauthorized", { status: 401 });
      const { pairingId, code } = await request.json().catch(() => ({}));
      if (!/^[0-9a-f]{32}$/.test(pairingId || "") || !/^\d{4}$/.test(code || "")) return new Response("bad request", { status: 400 });
      const broker = env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));
      const r = await broker.fetch(new Request("https://link/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "verify", code }),
      }));
      const result = await r.json();
      if (result.ok) {
        const hub = env.StatusHub.get(env.StatusHub.idFromName("status:" + result.scope));
        await hub.fetch(new Request("https://status-hub/broadcast", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: { type: "link_release", pairingId } }),
        }));
      }
      // never leak the matched scope to the new device
      return Response.json({ ok: !!result.ok, remaining: result.remaining, dead: result.dead, expired: result.expired });
    }

    if (url.pathname === "/agent/link/complete") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const caller = await resolveScope(tok, env);
      if (!caller) return new Response("unauthorized", { status: 401 });
      const { pairingId, blob } = await request.json().catch(() => ({}));
      if (!/^[0-9a-f]{32}$/.test(pairingId || "") || !blob) return new Response("bad request", { status: 400 });
      const broker = env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));
      const r = await broker.fetch(new Request("https://link/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "complete", callerScope: caller, blob }),
      }));
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/agent/link/cancel") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const caller = await resolveScope(tok, env);
      if (!caller) return new Response("unauthorized", { status: 401 });
      const { pairingId } = await request.json().catch(() => ({}));
      if (!/^[0-9a-f]{32}$/.test(pairingId || "")) return new Response("bad request", { status: 400 });
      const broker = env.LinkBroker.get(env.LinkBroker.idFromName(pairingId));
      const r = await broker.fetch(new Request("https://link/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "cancel", callerScope: caller }),
      }));
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    }

    { const r = await handleUsageRoute(url, request, env); if (r) return r; }

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
function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
