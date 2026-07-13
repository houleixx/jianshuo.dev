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
import { TOOL_DEFS, deleteArticleFiles } from "./tools.js";
import { runCommandTurn } from "./command-turn.js";
import { sendPush } from "./push.js";
import { runMine, scopesWithWork, loadModelConfig, resolveEditModel, MINE_RESUME_MS, restyleArticle } from "./miner.js";
import { buildHistoryMessages, HISTORY_MAX_TURNS } from "./history.js";
import { withTopLevelArticles } from "../../functions/lib/article-store.js";
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";
import { buildBroadcastMessage, createPairing, verifyPairing, completePairing, resolveMatchingScopes, genDistinctCodes, CODE_TTL_MS } from "./devicelink.js";
import { writeLlmLog } from "./llmlog.js";
import { QUEUE_TABLE_SQL, makeSqlStore, ArticleQueue } from "./queue.js";
import { runEditTurn } from "./edit-turn.js";
import { proxyVolcAsrWebSocket } from "./asr-proxy.js";
import { editGate, claudeCostUY, imageCostUY, uyToSuanli, uyToYuan, suanliToUY, RATE, DAY_MS, CAMPAIGN_EXPIRE_DAYS, reasonZH, DAILY_POOL_SUANLI, DAILY_POOL_UY, FUSE_MULT, ucToCoins } from "./usage.js";
import { ensureAccount, debit, editCount, getLedger, grantBucket, allAccounts, mintLedger, referralLedger, usageSummary } from "./usage_store.js";
import { handleMintRoutes, feedQuote } from "./mint.js";
import { handleReferralRoutes, publishMintRate } from "./referral.js";
import { handlePromptShareRoutes } from "./prompt-share.js";
import { writeStyleDoc } from "../../functions/lib/style-store.js";
import { distillStyle, buildStyleIntroArticle, STYLE_INTRO_STEM, corpusChars, MIN_CORPUS_CHARS } from "./style-extract.js";
import { silentM4aBytes } from "./silent-m4a.js";
import { callAnthropic, anthropicFetch, relayCall, RELAY_INSTANCE, RELAY_LOCATION_HINT } from "./anthropic.js";
import { makePreviewPusher, makeEditPreview } from "./preview.js";
import { handlePromptsRoute, handlePromptImport } from "./prompt-routes.js";
import { handlePromptRegistry } from "./prompt-registry.js";
import { xhsPack } from "./xhs.js";
import { handlePromptLab } from "./prompt-lab.js";
import { handleRealtimeSession, probeOpenAI, RT_RELAY_LOCATION_HINT } from "./realtime.js";
import { REVISE_SYSTEM, EDIT_SYSTEM as SYSTEM } from "./prompts/edit.js";
export { AnthropicRelay, RealtimeRelay } from "./relay.js";

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

// 库级指令门：只看余额，不设每文章上限（指令是库级、不按篇计）。fail-open。
export async function meteredCommandGate(db, scope, now) {
  if (!db) return "ok";
  try {
    const bal = await ensureAccount(db, scope, now);
    return bal > 0 ? "ok" : "no-credit";
  } catch { return "ok"; }
}

// resolveArticles + withTopLevelArticles are imported from the shared
// functions/lib/article-store.js (single source of truth).

// REVISE_SYSTEM / SYSTEM (owner-voice DNA + edit agent prompt) now live in
// ./prompts/edit.js (imported above as REVISE_SYSTEM / SYSTEM).

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
  // 实时预览通道：/agent/restyle（普通 worker 路由）把重写生成中的增量 POST 进来，
  // 由本 DO 广播给已连接的详情页 WS。外部到不了这里——/agent/edit 只放行 WS 升级，
  // 这个 HTTP 入口只有服务端拿着同名 stub 才能调（DO 名内嵌 scope，跨用户无法命中）。
  async onRequest(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/preview") {
      const msg = await request.text();
      try { this.broadcast(msg); } catch (_) {}
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  onConnect(connection, ctx) {
    const key = ctx.request.headers.get("x-vd-article-key");
    const scope = ctx.request.headers.get("x-vd-scope");
    const token = bearerToken(ctx.request);
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
    // 实时预览（Phase 2）：模型流式产出工具参数时，把 write_article 的整篇正文
    // （幽灵稿）和 edit_current_article 的行级新文本（打字机）边生成边广播给
    // 已连接的详情页。DO 内直连 broadcast，best-effort。
    const editPreview = makeEditPreview((obj) => this.broadcast(JSON.stringify(obj)));
    const callClaude = this._makeLoggedCall({ turnId, scope, stem, instruction: row.text, model: editModel, onEvent: editPreview.onEvent });

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
    editPreview.finish();   // 幽灵稿收尾（updated 紧随其后广播）

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
  // {ok, status, json, errorText, via, colo?} (never throws on HTTP/network
  // errors) so the caller can both log the exchange and decide how to proceed.
  // callAnthropic falls back to the ENAM relay DO when this DO's colo is
  // geo-blocked by Anthropic (see anthropic.js).
  async _callClaudeRaw(reqBody, onEvent = null) {
    return callAnthropic(this.env, reqBody, { onEvent });
  }

  // A logging callClaude for runAgentLoop: builds the request body, calls the
  // API, records one llmlogs/ entry per HTTP call (grouped by turnId), then
  // returns the response JSON or throws (preserving the loop's prior behavior).
  _makeLoggedCall({ turnId, scope, stem, instruction, model = MODEL, onEvent = null }) {
    let step = 0;
    return async ({ system, messages, tools }) => {
      const reqBody = { model, max_tokens: 8000, system, messages, tools };
      // tool_choice:auto is only valid WITH tools. merge_articles calls callClaude
      // with no tools (pure text synthesis) — including it there → Anthropic 400.
      if (tools && tools.length) reqBody.tool_choice = { type: "auto" };
      const myStep = step++;
      const ts = Date.now();
      const r = await this._callClaudeRaw(reqBody, onEvent);
      await writeLlmLog(this.env, {
        ts, source: "agent", user_scope: scope, model,
        latency_ms: Date.now() - ts, http_status: r.status, ok: r.ok,
        via: r.via, ...(r.colo ? { colo: r.colo } : {}),
        turn_id: turnId, step: myStep, request: reqBody,
        response: r.ok ? r.json : undefined,
        error: r.ok ? undefined : r.errorText,
        meta: { stem, instruction },
      });
      // Debit the cost of this API call. Best-effort: never breaks the edit.
      try {
        if (this.env.USAGE) {
          const u = r.json?.usage || {};
          await debit(this.env.USAGE, scope, claudeCostUY(model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
            "edit", { model, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId }, Date.now());
        }
      } catch {}
      if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${(r.errorText || "").slice(0, 160)}`);
      return r.json;
    };
  }
}

// ---------------------------------------------------------------------------
// LibraryAgent: one Durable Object per USER (not per article) — the 语音指令
// agent for "我的录音" list-level commands (merge / delete / restyle / tag /
// write_style). Clones ArticleEditor's scaffolding (config/history/queue
// tables, drain loop, logged Claude calls) but has no single doc to load —
// each turn runs the command tool loop via runCommandTurn, and destructive
// actions (delete) are staged in the config table pending a confirm/cancel
// round-trip over the same socket.
// ---------------------------------------------------------------------------
export class LibraryAgent extends Agent {
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
    try { this.sql`ALTER TABLE queue ADD COLUMN article_index INTEGER`; } catch (_) {}
    // Recover after hibernation/eviction: reset any leftover 'running' row and
    // drain whatever is pending — even with no client connected.
    if (this._queue.recover()) this.schedule(0, "drainQueue");
  }

  // The Worker has already authenticated the request and injected the
  // token-derived scope as a header. Persist it (no articleKey — library-level).
  onConnect(connection, ctx) {
    const scope = ctx.request.headers.get("x-vd-scope");
    const token = bearerToken(ctx.request);
    const set = (k, v) => { if (v) this.sql`INSERT INTO config (k, v) VALUES (${k}, ${v}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`; };
    set("scope", scope);
    set("token", token);
    // 库级无单一 doc，snapshot 只回队列状态。
    try { connection.send(JSON.stringify({ type: "snapshot", queue: this._queue.snapshot() })); } catch (_) {}
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
        loadDoc: async () => null, // 库级没有单一 doc
        runTurn: (row) => this.runTurn(row),
      });
    }
    return this.__queue;
  }

  // Scheduled drain entry point (durable; survives hibernation/eviction).
  async drainQueue() { await this._queue.drain(); }

  // Execute one queued instruction via the shared command-turn runner.
  async runTurn(row) {
    const { scope, token } = this._config();
    if (!scope) return { ok: false, error: "会话未初始化" };

    // Per-turn done-marker: if this row already completed once (turn finished but
    // the DO was evicted before the queue row was markDone'd → recover re-runs),
    // short-circuit instead of re-executing (which would double-bill a restyle /
    // re-run a non-idempotent tool). Best-effort; a missing marker just re-runs.
    const doneKey = `${scope}command-turns/${row.id}.json`;
    if (await this.env.FILES.head(doneKey)) return { ok: true, reply: "（已处理）", article: null };

    const decision = await meteredCommandGate(this.env.USAGE, scope, Date.now());
    if (decision === "no-credit") return { ok: false, error: "算力不足" };

    const turnId = `${Date.now()}-${rand6()}`;
    const model = resolveEditModel(await loadModelConfig(this.env));
    const callClaude = this._makeLoggedCall({ turnId, scope, stem: "", instruction: row.text, model });
    // refs 走 queue 的 images 列（客户端发来的编号清单 [{n,stem,title}]，见 onMessage）。
    const refs = row.images ? (() => { try { return JSON.parse(row.images); } catch { return []; } })() : [];
    // 带上最近几轮对话（同单篇编辑 DO），模型才接得住「刚才那两篇」「再来一次」。
    let history = [];
    try {
      const rows = this.sql`SELECT instruction, reply FROM history ORDER BY id DESC LIMIT 100`;
      history = buildHistoryMessages([...rows].reverse(), { maxTurns: HISTORY_MAX_TURNS });
    } catch (_) {}
    const res = await runCommandTurn({
      env: this.env, scope, token, origin: "https://jianshuo.dev", turnId,
      instruction: row.text, refs, callClaude, idemKey: row.id, history,
    });

    // 破坏性 pending → 存起来、发 confirm，不落地。confirm 卡要列全 res.pending 里
    // 每一条待删标题，因为 _resolvePending 确认时会删掉全部暂存动作。
    if (res.pending && res.pending.length) {
      this.sql`INSERT INTO config (k, v) VALUES (${"pending:" + row.id}, ${JSON.stringify(res.pending)}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
      const titles = res.pending.map((p) => `《${p.title}》`).join("、");
      this.broadcast(JSON.stringify({ type: "confirm", id: row.id, summary: `要删掉${titles}吗？`, action: res.pending }));
      return { ok: true, reply: res.reply, article: null, _pending: true };
    }

    this.sql`INSERT INTO history (instruction, reply, created_at) VALUES (${row.text}, ${res.reply || "（已处理）"}, ${Date.now()})`;
    // Mark this turn done (only on success — not pending, not error) so an
    // eviction-before-markDone re-run short-circuits above instead of re-executing.
    if (res.ok && !res.hadError) {
      try { await this.env.FILES.put(doneKey, JSON.stringify({ at: Date.now(), reply: res.reply || "" })); } catch {}
    }
    return { ok: res.ok, reply: res.reply, error: res.hadError ? (res.reply || "操作没完成") : undefined,
             article: null, stems: res.stems || [] };
  }

  async onMessage(connection, message) {
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : ""); } catch { return; }
    if (!msg) return;
    if (msg.type === "confirm") return this._resolvePending(connection, msg.id, true);
    if (msg.type === "cancel") return this._resolvePending(connection, msg.id, false);
    if (msg.type !== "instruct") return;

    const instruction = String(msg.text || "").trim();
    if (!instruction) { connection.send(JSON.stringify({ type: "error", message: "空指令" })); return; }

    const id = (typeof msg.id === "string" && msg.id) ? msg.id : `srv-${Date.now()}-${rand6()}`;
    // 编号清单（[{n, stem, title}, ...]）走 queue 的 images 列，供 runTurn 里读回当 refs。
    const refs = Array.isArray(msg.refs) ? msg.refs.filter((r) => r && r.stem) : [];

    const r = await this._queue.submit({ id, text: instruction, images: refs, article_index: 0 });
    if (r.kind === "replay") {
      // Already known — re-push its cached result to THIS caller, never re-run.
      // 库级没有单一 doc 可重发，只重放状态/回复。
      const row = r.row;
      if (row.status === "done") {
        if (row.reply) connection.send(JSON.stringify({ type: "reply", id, text: row.reply, ok: true }));
      } else if (row.status === "error") {
        connection.send(JSON.stringify({ type: "error", id, message: row.error || "操作没完成" }));
      } else {
        connection.send(JSON.stringify({ type: "status", state: "working", id }));
      }
      return;
    }
    connection.send(JSON.stringify({ type: "status", state: "working", id }));
    this.schedule(0, "drainQueue");
  }

  // 确认/取消一个暂存的破坏性动作（目前只有 delete_article）。
  async _resolvePending(connection, id, ok) {
    const { scope } = this._config();
    const rows = this.sql`SELECT v FROM config WHERE k = ${"pending:" + id}`;
    const raw = rows[0]?.v;
    if (!raw) return;
    this.sql`DELETE FROM config WHERE k = ${"pending:" + id}`;
    if (!ok) {
      // 收尾队列行：取消后别让 recover() 再翻回来重问。
      try { this._queue.store.markDone(id, "已取消"); } catch {}
      connection.send(JSON.stringify({ type: "reply", id, text: "已取消", ok: true }));
      return;
    }

    let actions = [];
    try { actions = JSON.parse(raw); } catch (_) {}
    for (const a of actions) {
      if (a.action === "delete") await deleteArticleFiles(this.env, scope, a.stem);
    }
    this.sql`INSERT INTO history (instruction, reply, created_at) VALUES (${"（确认删除）"}, ${"已删除"}, ${Date.now()})`;
    // 把队列里那条暂存 running 的行收尾，避免 recover() 把已解决的 pending 再翻回来重问。
    try { this._queue.store.markDone(id, "已删除"); } catch {}
    connection.send(JSON.stringify({ type: "reply", id, text: "已删除", ok: true }));
    this.broadcast(JSON.stringify({ type: "updated", id, article: null,
                                    stems: actions.map((a) => a.stem).filter(Boolean) })); // 客户端据此按 stem 清缓存并刷新列表
  }

  // One Anthropic Messages call WITH tools. Returns a result object
  // {ok, status, json, errorText, via, colo?} (never throws on HTTP/network
  // errors) so the caller can both log the exchange and decide how to proceed.
  // callAnthropic falls back to the ENAM relay DO when this DO's colo is
  // geo-blocked by Anthropic (see anthropic.js).
  async _callClaudeRaw(reqBody, onEvent = null) {
    return callAnthropic(this.env, reqBody, { onEvent });
  }

  // A logging callClaude for runAgentLoop: builds the request body, calls the
  // API, records one llmlogs/ entry per HTTP call (grouped by turnId), then
  // returns the response JSON or throws (preserving the loop's prior behavior).
  _makeLoggedCall({ turnId, scope, stem, instruction, model = MODEL }) {
    let step = 0;
    return async ({ system, messages, tools }) => {
      const reqBody = { model, max_tokens: 8000, system, messages, tools };
      // tool_choice:auto is only valid WITH tools. merge_articles calls callClaude
      // with no tools (pure text synthesis) — including it there → Anthropic 400.
      if (tools && tools.length) reqBody.tool_choice = { type: "auto" };
      const myStep = step++;
      const ts = Date.now();
      const r = await this._callClaudeRaw(reqBody);
      await writeLlmLog(this.env, {
        ts, source: "agent", user_scope: scope, model,
        latency_ms: Date.now() - ts, http_status: r.status, ok: r.ok,
        via: r.via, ...(r.colo ? { colo: r.colo } : {}),
        turn_id: turnId, step: myStep, request: reqBody,
        response: r.ok ? r.json : undefined,
        error: r.ok ? undefined : r.errorText,
        meta: { stem, instruction },
      });
      // Debit the cost of this API call. Best-effort: never breaks the edit.
      try {
        if (this.env.USAGE) {
          const u = r.json?.usage || {};
          await debit(this.env.USAGE, scope, claudeCostUY(model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
            "edit", { model, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId }, Date.now());
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
// Miner: sharded Durable Object that serialises mine runs via alarm().
// One DO per user (idFromName "miner:<scope>") mines ONLY that user's prefix —
// one user's long recording no longer queues everyone else, and each pass lists
// one user's objects instead of the whole bucket. One alarm at a time per shard
// still prevents duplicate ASR calls when uploads burst.
// The legacy singleton (idFromName "miner") no longer mines: it is the sweep
// dispatcher (cron/admin) — one whole-bucket list, then it pokes the shard of
// every scope with unprocessed work. It also keeps the ops error counters.
// ---------------------------------------------------------------------------
export class Miner {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── ops 错误计数（报警机制）──────────────────────────────────────────────
    // Pages/Worker 的 4xx/5xx 打点进来按「分钟桶 × 路由|状态」累计；/ops/check
    // 由 */5 cron 调，聚合最近 15 分钟并按阈值给出报警（同规则 60 分钟静默）。
    if (url.pathname === "/ops/tick") {
      const b = await request.json().catch(() => ({}));
      const route = String(b.route || "?").slice(0, 40);
      const status = Number(b.status) || 0;
      const bucket = Math.floor(Date.now() / 60000);
      const key = `ops:${bucket}`;
      const cur = (await this.state.storage.get(key)) || {};
      const k = `${route}|${status}`;
      cur[k] = (cur[k] || 0) + 1;
      await this.state.storage.put(key, cur);
      return new Response("ok");
    }
    // ── voicedrop.cn 备案接入点探活(腾讯云机器随时可能释放/不稳)────────────
    // */5 cron 每轮报告一次探活结果;连续 ≥2 次失败且 60 分钟内未报过 → 报警。
    if (url.pathname === "/ops/probe") {
      const { ok } = await request.json().catch(() => ({ ok: true }));
      let fails = (await this.state.storage.get("probe:fails")) || 0;
      fails = ok ? 0 : fails + 1;
      await this.state.storage.put("probe:fails", fails);
      let alert = null;
      if (fails >= 2) {
        const last = (await this.state.storage.get("probe:alertedAt")) || 0;
        if (Date.now() - last > 60 * 60 * 1000) {
          await this.state.storage.put("probe:alertedAt", Date.now());
          alert = { fails };
        }
      }
      return Response.json({ alert });
    }
    if (url.pathname === "/ops/check") {
      const nowBucket = Math.floor(Date.now() / 60000);
      const all = await this.state.storage.list({ prefix: "ops:" });
      const agg = {};   // route → {c4, c5, samples}
      for (const [key, val] of all) {
        const bucket = Number(key.slice(4));
        if (bucket < nowBucket - 30) { await this.state.storage.delete(key); continue; }
        if (bucket < nowBucket - 15) continue;
        for (const [rk, n] of Object.entries(val)) {
          const [route, st] = rk.split("|");
          const cls = Number(st) >= 500 ? "c5" : "c4";
          agg[route] = agg[route] || { c4: 0, c5: 0 };
          agg[route][cls] += n;
        }
      }
      const alerts = [];
      const now = Date.now();
      for (const [route, { c4, c5 }] of Object.entries(agg)) {
        for (const [cls, count, threshold] of [["4xx", c4, 20], ["5xx", c5, 5]]) {
          if (count < threshold) continue;
          const ruleKey = `opsAlerted:${route}|${cls}`;
          const last = (await this.state.storage.get(ruleKey)) || 0;
          if (now - last < 60 * 60 * 1000) continue;   // 60 分钟静默去重
          await this.state.storage.put(ruleKey, now);
          alerts.push({ route, cls, count });
        }
      }
      return Response.json({ alerts });
    }

    // ── 默认：挖矿排队 ──────────────────────────────────────────────────────
    // A user shard is told its scope on first poke and remembers it (the alarm
    // handler has no request to read it from). No scope = the sweep dispatcher.
    const scope = url.searchParams.get("scope") || "";
    if (scope) await this.state.storage.put("scope", scope);
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(Date.now() + 500);
    return new Response("queued", { status: 202 });
  }

  async alarm() {
    const scope = await this.state.storage.get("scope");
    if (scope) {
      // Per-user shard: runMine processes a bounded slice (subrequest budget) of
      // THIS user's prefix and tells us if ASR is still cooking or work was
      // deferred — if so, come back soon to resume so long audio finishes across
      // passes instead of timing out in one invocation.
      const r = await runMine(this.env, scope);
      if (r && r.moreWork) await this.state.storage.setAlarm(Date.now() + MINE_RESUME_MS);
      return;
    }
    // Sweep dispatcher (cron/admin trigger): one whole-bucket list, then poke the
    // shard of every scope that still has unprocessed work. Mining itself always
    // happens in the shards, so a sweep can never double-process a recording that
    // a shard is already working on.
    const scopes = await scopesWithWork(this.env);
    for (const s of scopes) {
      const stub = this.env.Miner.get(this.env.Miner.idFromName("miner:" + s));
      await stub.fetch(new Request("https://miner/?scope=" + encodeURIComponent(s), { method: "POST" }));
    }
    if (scopes.length) console.log(`[mine] sweep: poked ${scopes.length} shard(s)`);
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
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export async function handleUsageRoute(url, request, env) {
  if (!url.pathname.startsWith("/agent/usage/")) return null;
  try {
  const tok = bearerToken(request);
  const isAdmin = env.FILES_TOKEN && tok === env.FILES_TOKEN;

  if (url.pathname === "/agent/usage/balance" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ suanli: 0, yuan: 0, granted_suanli: 0, spent_suanli: 0, degraded: true });
    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);   // 返回活余额
    const a = await env.USAGE.prepare("SELECT granted_uy,spent_uy FROM account WHERE user_sub=?").bind(scope).first();
    return J({ suanli: r1(uyToSuanli(bal)), yuan: r2(uyToYuan(bal)),
      granted_suanli: r1(uyToSuanli(a.granted_uy)), spent_suanli: r1(uyToSuanli(a.spent_uy)) });
  }

  if (url.pathname === "/agent/usage/ledger" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ entries: [], degraded: true });
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    // 翻页游标：before="<ts>-<id>"（上一页最后一行），keyset 不漂移。多取 1 行探测还有没有。
    let before = null;
    const bp = (url.searchParams.get("before") || "").match(/^(\d+)-(\d+)$/);
    if (bp) before = { ts: parseInt(bp[1], 10), id: parseInt(bp[2], 10) };
    const rows = await getLedger(env.USAGE, scope, limit + 1, before);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    // reason 出口翻译成中文（老 App 直接显示 reason 字段 → 无需发版即全中文）；
    // 英文码保留在 reason_code，给需要程序判断的新客户端用。
    return J({ entries: page.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, reason: reasonZH(e.reason), reason_code: e.reason,
      suanli: r1(uyToSuanli(e.amount_uy)), yuan: r2(uyToYuan(e.amount_uy)),
      balance_suanli: r1(uyToSuanli(e.balance_uy)), detail: e.detail ? JSON.parse(e.detail) : null })),
      has_more: hasMore, next: hasMore && last ? `${last.ts}-${last.id}` : null });
  }

  if (url.pathname === "/agent/usage/summary" && request.method === "GET") {
    const scope = await resolveScope(tok, env);
    if (!scope) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ granted: [], spent: [], degraded: true });
    // 全量 ledger 聚合（非 50 条窗口）：来源、花费各按中文名归组——campaign:* 合并为
    // 活动赠送、xhs-pack/xhs-tags 合并为小红书分享，与明细页的展示口径一致。
    const rows = await usageSummary(env.USAGE, scope);
    const groups = { grant: new Map(), spend: new Map() };
    for (const row of rows) {
      const m = groups[row.kind];
      if (!m) continue;
      const zh = reasonZH(row.reason);
      const g = m.get(zh) || { reason_code: row.reason.startsWith("campaign:") ? "campaign" : row.reason, reason: zh, uy: 0, count: 0 };
      g.uy += row.total_uy; g.count += row.n;
      m.set(zh, g);
    }
    const out = (m) => [...m.values()].sort((a, b) => b.uy - a.uy)
      .map((g) => ({ reason_code: g.reason_code, reason: g.reason, suanli: r1(uyToSuanli(g.uy)), count: g.count }));
    const total = (kind) => rows.filter((x) => x.kind === kind).reduce((s, x) => s + x.total_uy, 0);
    return J({ granted: out(groups.grant), spent: out(groups.spend),
      granted_suanli: r1(uyToSuanli(total("grant"))), spent_suanli: r1(uyToSuanli(total("spend"))) });
  }

  if (url.pathname === "/agent/usage/grant" && request.method === "POST") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.user_sub || !Number.isFinite(b.suanli)) return J({ error: "bad-request" }, 400);
    const now = Date.now();
    const days = Number.isFinite(b.expire_days) ? b.expire_days : CAMPAIGN_EXPIRE_DAYS;
    const expiresAt = now + days * DAY_MS;
    await grantBucket(env.USAGE, b.user_sub, suanliToUY(b.suanli), "campaign:" + (b.reason || "manual"), expiresAt, now);
    return J({ ok: true, suanli: b.suanli, cost_yuan: r2(b.suanli / RATE), expires_at: expiresAt });
  }

  if (url.pathname === "/agent/usage/grant/batch" && request.method === "POST") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!Number.isFinite(b.suanli)) return J({ error: "bad-request" }, 400);
    const now = Date.now();
    const days = Number.isFinite(b.expire_days) ? b.expire_days : CAMPAIGN_EXPIRE_DAYS;
    const expiresAt = now + days * DAY_MS;
    let targets = Array.isArray(b.user_subs) ? b.user_subs.filter((s) => typeof s === "string" && s) : null;
    if ((!targets || targets.length === 0) && b.all === true) {
      targets = (await allAccounts(env.USAGE, now)).map((a) => a.user_sub);
    }
    if (!targets || targets.length === 0) return J({ error: "bad-request", hint: "user_subs[] or all:true" }, 400);
    const source = "campaign:" + (b.reason || "manual");
    for (const u of targets) {
      await grantBucket(env.USAGE, u, suanliToUY(b.suanli), source, expiresAt, now);
    }
    return J({ ok: true, count: targets.length, suanli_each: b.suanli, cost_yuan: r2((b.suanli * targets.length) / RATE), expires_at: expiresAt });
  }

  if (url.pathname === "/agent/usage/admin/accounts" && request.method === "GET") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    const rows = await allAccounts(env.USAGE, Date.now());
    return J({ accounts: rows.map((a) => ({ user_sub: a.user_sub,
      balance_suanli: r1(uyToSuanli(a.balance_uy)), granted_suanli: r1(uyToSuanli(a.granted_uy)),
      spent_suanli: r1(uyToSuanli(a.spent_uy)), spent_yuan: r2(uyToYuan(a.spent_uy)) })) });
  }

  // 投喂挖矿账本：mint 表全站聚合（累计挖出/今日池/币价/熔断）+ 每人收益排行 + 最近流水。
  if (url.pathname === "/agent/usage/admin/mint" && request.method === "GET") {
    if (!isAdmin) return J({ error: "unauthorized" }, 401);
    if (!env.USAGE) return J({ summary: {}, board: [], events: [], degraded: true });
    const now = Date.now();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "80", 10) || 80, 300);
    const { summary, today, sum7, board, events } = await mintLedger(env.USAGE, now, limit);
    const ref = await referralLedger(env.USAGE, now, Math.min(limit, 100));
    const priceUY = feedQuote(sum7, 0).priceUY;   // 当前币价（与 App 报价同口径）
    return J({
      summary: {
        events: summary.events,
        coins: r1(ucToCoins(summary.coins_uc)),
        minted_suanli: r1(uyToSuanli(summary.minted_uy)),
        author_suanli: r1(uyToSuanli(summary.author_uy)),
        feeder_suanli: r1(uyToSuanli(summary.feeder_uy)),
        today_suanli: r1(uyToSuanli(today.minted_uy)),
        today_events: today.events,
        daily_pool_suanli: DAILY_POOL_SUANLI,
        price_suanli_per_coin: r1(uyToSuanli(priceUY)),
        fuse_cap_suanli: r1(uyToSuanli(FUSE_MULT * DAILY_POOL_UY)),
        fuse_blown: today.minted_uy > FUSE_MULT * DAILY_POOL_UY,
      },
      board: board.map((b) => ({
        user_sub: b.sub,
        author_suanli: r1(uyToSuanli(b.author_uy)),
        feeder_suanli: r1(uyToSuanli(b.feeder_uy)),
        total_suanli: r1(uyToSuanli(b.author_uy + b.feeder_uy)),
        recv_cnt: b.recv_cnt, feed_cnt: b.feed_cnt,
      })),
      events: events.map((e) => {
        let d = null; try { d = e.detail ? JSON.parse(e.detail) : null; } catch (_) {}
        return {
          ts: e.ts, share_id: e.share_id,
          actor_sub: e.actor_sub, beneficiary_sub: e.beneficiary_sub,
          title: (d && d.title) || "",
          coins: r1(ucToCoins(e.coins_uc)),
          price_suanli_per_coin: r1(uyToSuanli(e.price_uy)),
          author_suanli: r1(uyToSuanli(e.beneficiary_uy)),
          feeder_suanli: r1(uyToSuanli(e.actor_uy)),
        };
      }),
      // 拉新（kind='referral'）：邀请人=beneficiary，新人=actor；via 是归因层。
      referral: {
        events: ref.summary.events,
        today_events: ref.today.events,
        minted_suanli: r1(uyToSuanli(ref.summary.minted_uy)),
        owner_suanli: r1(uyToSuanli(ref.summary.owner_uy)),
        newuser_suanli: r1(uyToSuanli(ref.summary.newuser_uy)),
        board: ref.board.map((b) => ({
          user_sub: b.sub, invited_cnt: b.invited_cnt,
          owner_suanli: r1(uyToSuanli(b.owner_uy)), last_ts: b.last_ts,
        })),
        events_list: ref.events.map((e) => {
          let d = null; try { d = e.detail ? JSON.parse(e.detail) : null; } catch (_) {}
          return {
            ts: e.ts, token: e.share_id || "",
            inviter_sub: e.beneficiary_sub, newuser_sub: e.actor_sub,
            via: (d && d.via) || "", capped: !!(d && d.capped),
            owner_suanli: r1(uyToSuanli(e.beneficiary_uy)),
            newuser_suanli: r1(uyToSuanli(e.actor_uy)),
          };
        }),
      },
    });
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── /agent/llm-health ── admin: probe the direct Anthropic path AND the
    // ENAM relay DO (colo + a 1-token call each), so a geo-block regression is
    // diagnosable in one curl instead of by fishing llmlogs.
    if (url.pathname === "/agent/llm-health") {
      const tok = bearerToken(request);
      if (!env.FILES_TOKEN || tok !== env.FILES_TOKEN) return new Response("unauthorized", { status: 401 });
      const ping = { model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
      const trace = await fetch("https://www.cloudflare.com/cdn-cgi/trace").then((r) => r.text()).catch(() => "");
      const workerColo = (trace.match(/^colo=(\w+)/m) || [])[1] || "";
      const d = await anthropicFetch(env.CLAUDE_API_KEY, ping);
      let relay = { error: "no-binding" };
      if (env.RELAY) {
        try {
          const stub = env.RELAY.get(env.RELAY.idFromName(RELAY_INSTANCE), { locationHint: RELAY_LOCATION_HINT });
          // relayCall 会把中继回流的 SSE 聚合掉（Phase3 后 /messages 是流式回流，
          // 在这里裸 .json() 会炸），返回和直连同形状的 {ok,status,errorText}。
          const [coloResp, r] = await Promise.all([
            stub.fetch("https://relay/colo"),
            relayCall(env, env.CLAUDE_API_KEY, ping),
          ]);
          const relayColo = (await coloResp.json()).colo;
          relay = { colo: relayColo, ok: r.ok, status: r.status, errorText: r.ok ? undefined : r.errorText };
        } catch (e) {
          relay = { error: String((e && e.message) || e) };
        }
      }
      // OpenAI 这条腿（realtime 采访）：同样直连 + ENAM 中继 DO 各探一次，
      // HKG geo-block 回归时这里一眼看穿（见 src/realtime.js）。
      const openaiDirect = await probeOpenAI(env);
      let openaiRelay = { error: "no-binding" };
      if (env.RT_RELAY) {
        try {
          const rtStub = env.RT_RELAY.get(env.RT_RELAY.newUniqueId(), { locationHint: RT_RELAY_LOCATION_HINT });
          const [rtColoResp, rtProbeResp] = await Promise.all([
            rtStub.fetch("https://relay/colo"),
            rtStub.fetch("https://relay/probe"),
          ]);
          openaiRelay = { colo: (await rtColoResp.json()).colo, ...(await rtProbeResp.json()) };
        } catch (e) {
          openaiRelay = { error: String((e && e.message) || e) };
        }
      }
      return Response.json({
        workerColo,
        direct: { ok: d.ok, status: d.status, errorText: d.ok ? undefined : d.errorText },
        relay,
        openai: { direct: openaiDirect, relay: openaiRelay },
      });
    }

    // ── /agent/edit ── existing article-editing agent ──────────────────────
    if (url.pathname === "/agent/edit") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const token = bearerToken(request);
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

    // ── /agent/command ── 库级语音指令 agent（每用户一个 DO，无 stem）───────────
    if (url.pathname === "/agent/command") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const token = bearerToken(request);
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      const agent = await getAgentByName(env.LibraryAgent, sanitizeName(scope + ":command"));
      const fwd = new Request(request);
      fwd.headers.set("x-vd-scope", scope);
      return agent.fetch(fwd);
    }

    // ── /agent/status ── app WebSocket for real-time status updates ─────────
    if (url.pathname === "/agent/status") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const token = bearerToken(request);
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
      const token = bearerToken(request);
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });

      return proxyVolcAsrWebSocket(request, env);
    }

    // ── /agent/realtime/relay ── 认证 WS 中转：手机 → 本 worker → OpenAI realtime。
    // 手机连不了 api.openai.com，worker 在边缘用 OPENAI_API_KEY 连 OpenAI；服务端计费。
    if (url.pathname === "/agent/realtime/relay") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const token = bearerToken(request);
      const scope = await resolveScope(token, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      return handleRealtimeSession(request, env, scope, ctx);
    }

    // ── /agent/prompt-registry ── 线上 prompt 注册表（管理 token）。GET 打平列出
    // prompt-template 生效版里的全部叶子指令；PUT 改一条并写回 R2 覆盖文件=零部署上线。
    if (url.pathname === "/agent/prompt-registry") {
      return handlePromptRegistry(request, env);
    }

    // ── /agent/prompt-lab/* ── 题图调优桥接页后端：文章列表 + paint 出图代理（管理 token）──
    if (url.pathname.startsWith("/agent/prompt-lab/")) {
      return handlePromptLab(request, env, url);
    }

    // ── /agent/prompts ── 用户的一套有序提示词列表（ref 跟随模板 / 实体冻结）。
    // GET 读解析后的列表；PUT 整树写（新建/删除/改名/排序/分组/fork 全走它）；
    // POST /restore-defaults 补回模板里缺的；POST /import 魔法数字导入成自建副本。
    // spec 2026-07-13-prompt-manager-redesign.md
    if (url.pathname === "/agent/prompts" || url.pathname === "/agent/prompts/restore-defaults"
        || url.pathname === "/agent/prompts/import") {
      const scope = await resolveScope(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (url.pathname === "/agent/prompts/import") return handlePromptImport(request, env, scope);
      return handlePromptsRoute(request, env, scope, url);
    }

    // ── /agent/ops/tick ── 服务端错误打点（Pages Functions 4xx/5xx 时 fire-and-forget）──
    // 无鉴权：只累加计数、无副作用；载荷截断，恶意灌水最多触发一条报警。
    if (url.pathname === "/agent/ops/tick" && request.method === "POST") {
      const body = await request.text();
      const stub = env.Miner.get(env.Miner.idFromName("miner"));
      ctx.waitUntil(stub.fetch(new Request("https://miner/ops/tick", { method: "POST", body })));
      return new Response(null, { status: 204 });
    }

    // ── /agent/mine/trigger ── kick the miner (any authenticated user or admin) ──
    // A user token kicks that user's OWN miner shard (mines only their prefix);
    // an admin token kicks the sweep dispatcher (whole-bucket scan → poke shards).
    if (url.pathname === "/agent/mine/trigger") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = bearerToken(request);
      const isAdmin = env.FILES_TOKEN && tok === env.FILES_TOKEN;
      const scope   = isAdmin ? "admin" : await resolveScope(tok, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      const shard = scope === "admin" ? "miner" : "miner:" + scope;
      const stub = env.Miner.get(env.Miner.idFromName(shard));
      const target = scope === "admin" ? "https://miner/" : "https://miner/?scope=" + encodeURIComponent(scope);
      return stub.fetch(new Request(target, { method: "POST" }));
    }

    // ── /agent/restyle ── re-mine ONE recording from its stored transcript ──────
    // Body {stem, styleV?}. styleV 缺省 → 用当前文风 head（App 的"重写"：只带 stem，
    // 按原挖矿逻辑用当前文风重挖，可重新拆多篇）。Produces a new article version tagged <!-- style: 风格 vN -->,
    // head moves to it. The app calls this only when that style variant isn't already in
    // the article's versions[] (otherwise it just patchHead's — free). User token scoped.
    if (url.pathname === "/agent/restyle") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = bearerToken(request);
      const scope = await resolveScope(tok, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      const body = await request.json().catch(() => ({}));
      const stem = typeof body.stem === "string" ? body.stem : "";
      const styleV = Number.isInteger(body.styleV) ? body.styleV : null;   // null → restyleArticle 用当前文风 head（重写：只带 stem）
      if (!stem || stem.includes("/") || stem.includes("..")) {
        return new Response(JSON.stringify({ ok: false, error: "bad-request" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      // 实时预览（best-effort）：把生成中的增量推给同名编辑 DO，广播给已打开的
      // 详情页。App 收到 preview-done 即可收尾——就算这个 HTTP 响应超时/断线，
      // 结果也已落库、预览通道也宣告了完成。
      let pusher = null;
      try {
        const agent = await getAgentByName(env.ArticleEditor, sanitizeName(scope + stem));
        pusher = makePreviewPusher((obj) => agent.fetch(new Request("https://agent/preview", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj),
        })));
      } catch (_) {}
      const r = await restyleArticle(env, scope, stem, styleV, pusher && pusher.preview);
      if (pusher) { try { await pusher.done(r.ok); } catch (_) {} }
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : 422, headers: { "content-type": "application/json" } });
    }

    // ── /agent/xhs-pack ── 「分享到小红书」内容包：文章 → 小红书文案 + 图片 key ──
    // Body {stem}。一次 Claude 调用，按 token 实价扣算力（best-effort）。App 拿到
    // 包后写剪贴板 + 弹 ShareSheet，发布动作由用户在小红书 App 里完成。
    if (url.pathname === "/agent/xhs-pack") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = bearerToken(request);
      const scope = await resolveScope(tok, env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const stem = typeof body.stem === "string" ? body.stem : "";
      if (!stem || stem.includes("/") || stem.includes("..")) return J({ error: "bad-request" }, 400);
      const r = await xhsPack(env, scope, stem);
      return J(r, r.ok ? 200 : r.error === "not_found" ? 404 : 422);
    }

    // ── /agent/style/extract ── distill the collected 风格数据集 (「接受分享」
    // corpus, users/<sub>/style/<id>.json — see style-corpus.test.js / Task 2) into
    // ONE 写作风格 description and write it as a new CLAUDE.json version. Body
    // {clearAfter?}. Best-effort 算力 debit (same shape as _makeLoggedCall above) —
    // billing never blocks or fails the response.
    if (url.pathname === "/agent/style/extract") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = bearerToken(request);
      const scope = await resolveScope(tok, env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));

      const samples = [];
      let cursor;
      do {
        const listed = await env.FILES.list({ prefix: `${scope}style/`, cursor });
        for (const o of listed.objects) {
          const obj = await env.FILES.get(o.key);
          const s = obj && await obj.json().catch(() => null);
          if (s && (s.text || "").trim()) samples.push(s);
        }
        cursor = listed.truncated ? listed.cursor : null;
      } while (cursor);
      if (!samples.length) return J({ error: "empty-dataset" }, 400);
      // 硬闸（与 miner 的 mineStyleExtract 同口径）：语料有效字数不够就不蒸馏——
      // 否则蒸馏器的「无法蒸馏」说明卡会落成风格版本并成为生效文风。
      const totalChars = corpusChars(samples);
      if (totalChars < MIN_CORPUS_CHARS) return J({ error: "insufficient-corpus", totalChars, min: MIN_CORPUS_CHARS }, 400);

      // Same call shape as _makeLoggedCall: builds the request, hits the Anthropic
      // API directly (this route isn't inside a DO, so it can't reuse that method),
      // logs to llmlogs/ (best-effort, writeLlmLog swallows its own errors), and
      // captures token usage for the 算力 debit below.
      // distillStyle makes TWO Claude calls (Style Card + a dedicated naming call);
      // accumulate usage across both so the 算力 debit reflects the full cost.
      const usageSum = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const claude = async ({ system, messages }) => {
        const reqBody = { model: MODEL, max_tokens: 1500, system, messages };
        const t0 = Date.now();
        const r = await callAnthropic(env, reqBody);
        const j = r.json;
        await writeLlmLog(env, {
          ts: t0, source: "agent", user_scope: scope, model: MODEL,
          latency_ms: Date.now() - t0, http_status: r.status, ok: r.ok,
          via: r.via, ...(r.colo ? { colo: r.colo } : {}),
          step: 0, request: reqBody, response: r.ok ? j : undefined,
          error: r.ok ? undefined : r.errorText,
          meta: { kind: "style-extract", samples: samples.length },
        });
        if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
        const u = j.usage || {};
        usageSum.input_tokens += u.input_tokens || 0;
        usageSum.output_tokens += u.output_tokens || 0;
        usageSum.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
        usageSum.cache_read_input_tokens += u.cache_read_input_tokens || 0;
        return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      };

      // The heavy work — 2 Claude calls (蒸馏 Style Card + 起名) + writes — runs in the
      // BACKGROUND via ctx.waitUntil so the share sheet closes immediately instead of
      // spinning ~10-30s. The corpus was already validated non-empty above; a background
      // failure leaves the corpus intact (clearAfter runs only after a successful write),
      // so the user can just re-tap 提取. The 写作风格 version + intro article appear a few
      // seconds later (user refreshes 我的录音).
      const distillAndWrite = async () => {
        const style = await distillStyle(samples, claude);
        await writeStyleDoc(env, scope, style, "share-extract");
        // 写作风格介绍文章（固定 stem，覆盖上一篇）— article JSON 先于 .m4a → miner skip。
        try {
          const { title, body: introBody } = buildStyleIntroArticle(style, samples);
          const introDoc = {
            schema: 2, id: STYLE_INTRO_STEM, sourceAudio: `${STYLE_INTRO_STEM}.m4a`,
            createdAt: new Date().toISOString(), transcript: "", srt: "",
            articles: [{ title, body: introBody }], status: "ready", model: "style-intro",
          };
          await env.FILES.put(`${scope}articles/${STYLE_INTRO_STEM}.json`, JSON.stringify(introDoc), { httpMetadata: { contentType: "application/json" } });
          await env.FILES.put(`${scope}${STYLE_INTRO_STEM}.m4a`, silentM4aBytes(), { httpMetadata: { contentType: "audio/mp4" } });
        } catch (_) {}
        if (body.clearAfter) {
          try {
            for (const prefix of [`${scope}style/`, `${scope}VoiceDrop-style-`]) {
              let c;
              do {
                const l = await env.FILES.list({ prefix, cursor: c });
                for (const o of l.objects) await env.FILES.delete(o.key);
                c = l.truncated ? l.cursor : null;
              } while (c);
            }
          } catch (_) {}
        }
        try {
          if (env.USAGE) {
            await ensureAccount(env.USAGE, scope, Date.now());
            const cost = claudeCostUY(MODEL, usageSum.input_tokens, usageSum.output_tokens, usageSum.cache_creation_input_tokens, usageSum.cache_read_input_tokens);
            await debit(env.USAGE, scope, cost, "style-extract", { samples: samples.length }, Date.now());
          }
        } catch (_) {}
      };
      // Synchronous fallback endpoint. iOS now runs 提取风格 through the miner task flow
      // (upload a tagged placeholder + trigger — see mineStyleExtract), which is robust and
      // shows progress; this endpoint stays for debug/other callers and runs the distill inline.
      try { await distillAndWrite(); } catch (e) { return J({ error: "distill-failed", detail: String((e && e.message) || e) }, 500); }
      return J({ ok: true });
    }

    // ── /agent/paint-callback ── paint 出图完成回调：验 token → 幂等 → 写 R2 (+扣费) ──
    if (url.pathname === "/agent/paint-callback") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const tok = bearerToken(request);
      if (!env.PAINT_CALLBACK_TOKEN || tok !== env.PAINT_CALLBACK_TOKEN) return new Response("unauthorized", { status: 401 });
      const body = await request.json().catch(() => null);
      const m = body && body.callback_meta;
      if (!m || !m.scope || !m.newKey) return J({ error: "bad request" }, 400);
      // 防御纵深：token 泄露时把写/读/抓取都钉死在合法形状内。
      if (!/^users\/[^/]+\/$/.test(m.scope)) return J({ error: "bad scope" }, 400);
      if (!/^photos\/.+\.(png|jpe?g)$/i.test(m.newKey)) return J({ error: "bad newKey" }, 400);
      if (m.oldKey && !/^photos\/.+\.(png|jpe?g)$/i.test(m.oldKey)) return J({ error: "bad oldKey" }, 400);
      const fullNew = m.scope + m.newKey;
      // 幂等：结果键已存在 → 回调重送，直接成功不重复写/扣费
      if (await env.FILES.head(fullNew)) return J({ ok: true, dedup: true });
      if (body.status === "done" && body.result_url) {
        const paintBase = env.PAINT_BASE || "https://paint.jianshuo.dev";
        if (!String(body.result_url).startsWith(paintBase + "/")) return J({ error: "bad result_url" }, 400);
        const r = await globalThis.fetch(body.result_url);
        if (!r.ok) return J({ error: `fetch_result_${r.status}` }, 502);
        // R2.put 要求 body 有已知长度；fetch 的响应体流长度未知（paint /results 无 Content-Length），
        // 必须先缓冲成 ArrayBuffer，否则抛 "Provided readable stream must have a known length"。
        await env.FILES.put(fullNew, await r.arrayBuffer(), { httpMetadata: { contentType: r.headers.get("content-type") || "image/png" } });
        await debit(env.USAGE, m.scope, imageCostUY(), "image-edit", { jobId: body.job_id || null, newKey: m.newKey }, Date.now());
      } else {
        // 失败：写原图副本（保留原图可见），不扣费
        const o = m.oldKey ? await env.FILES.get(m.scope + m.oldKey) : null;
        if (o) await env.FILES.put(fullNew, await o.arrayBuffer(), { httpMetadata: { contentType: (o.httpMetadata && o.httpMetadata.contentType) || "image/jpeg" } });
      }
      return J({ ok: true });
    }

    // ── /agent/notify ── mine.py notifies about processing state ───────────
    if (url.pathname === "/agent/notify") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const adminToken = bearerToken(request);
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
      const tok = bearerToken(request);
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
      const tok = bearerToken(request);
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
      const tok = bearerToken(request);
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
      const tok = bearerToken(request);
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

    // 投币（铸币事件 + 双边算力到账）—— src/mint.js
    { const r = await handleMintRoutes(url, request, env); if (r) return r; }

    // 邀请奖励（新装归因 + 双边铸币入账）—— src/referral.js
    { const r = await handleReferralRoutes(url, request, env); if (r) return r; }

    // 指令分享码（魔法数字：POST 开分享 / DELETE 关分享）—— src/prompt-share.js
    { const r = await handlePromptShareRoutes(url, request, env); if (r) return r; }

    { const r = await handleUsageRoute(url, request, env); if (r) return r; }

    return new Response("not found", { status: 404 });
  },

  // CF Cron Triggers: 6 小时一次的挖矿兜底 + 每 5 分钟一次的错误报警检查。
  async scheduled(event, env, ctx) {
    const stub = env.Miner.get(env.Miner.idFromName("miner"));
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil((async () => {
        // 探活 voicedrop.cn(备案接入点)。挂了 → 推送报警,含回滚提示。
        try {
          let ok = false;
          try {
            const pr = await fetch("https://voicedrop.cn/", { signal: AbortSignal.timeout(10_000), redirect: "manual" });
            ok = pr.status < 500;
          } catch (_) {}
          const rp = await stub.fetch(new Request("https://miner/ops/probe", { method: "POST", body: JSON.stringify({ ok }) }));
          const { alert } = await rp.json().catch(() => ({}));
          if (alert) {
            console.log("[ops] voicedrop.cn PROBE DOWN", JSON.stringify(alert));
            if (env.ADMIN_SCOPE) {
              await sendPush(env, env.ADMIN_SCOPE, {
                title: "voicedrop.cn 探活失败",
                body: `连续 ${alert.fails} 次不可达——腾讯云接入点可能挂了。回滚: DNS 改回 CNAME jianshuo-dev.pages.dev(见 infra/voicedrop-cn/README)`,
                threadId: "ops",
              });
            }
          }
        } catch (e) { console.log("[ops] probe failed", String(e).slice(0, 120)); }
        try {
          const r = await stub.fetch(new Request("https://miner/ops/check", { method: "POST" }));
          const { alerts = [] } = await r.json().catch(() => ({}));
          for (const a of alerts) {
            console.log("[ops] ALERT", JSON.stringify(a));
            if (env.ADMIN_SCOPE) {
              await sendPush(env, env.ADMIN_SCOPE, {
                title: `服务端 ${a.cls} 报警`,
                body: `${a.route} 最近 15 分钟 ${a.cls} × ${a.count}`,
                threadId: "ops",
              });
            }
          }
        } catch (e) { console.log("[ops] check failed", String(e).slice(0, 200)); }
      })());
      return;
    }
    ctx.waitUntil(stub.fetch(new Request("https://miner/trigger", { method: "POST" })));
    // 6h 一次顺手刷新落地页 CTA 汇率（冷启动没铸币也有价可显示）。
    if (env.USAGE) ctx.waitUntil(publishMintRate(env, env.USAGE, Date.now()));
  },
};

// Resolve a writable scope from an app token. Read-only temp tokens are rejected
// (editing requires write). Returns 'users/<sub>/' or null.
export async function resolveScope(token, env) {
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
