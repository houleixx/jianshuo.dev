// Durable, idempotent, self-draining instruction queue for ONE article.
//
// Pure orchestration: FIFO ordering (by seq), idempotent dedup (by instruction
// id), status transitions, crash-safe exactly-once (via the doc's lastEditId),
// and broadcast. Every side-effect is injected so this unit tests with fakes:
//   store     — CRUD over queue rows (SQLite in the DO, in-memory in tests)
//   runTurn   — async (row) => {ok, reply, error, article}; the real Claude
//               loop + R2 write for one instruction (Task A3)
//   loadDoc   — async () => doc|null; current article doc, already client-ready
//               (withTopLevelArticles). doc.lastEditId drives the skip.
//   broadcast — (obj) => void; push a JSON-able message to all connections
//   schedule  — () => void; arm a durable drain (no-op in tests)
//   now       — () => epoch ms

export const QUEUE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  seq INTEGER,
  text TEXT,
  images TEXT,
  status TEXT,
  reply TEXT,
  error TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  article_index INTEGER
)`;

// In-memory store — the reference implementation + the test backend.
export function makeMemStore(now = () => Date.now()) {
  const rows = new Map(); // id -> row
  let maxSeq = 0;
  return {
    insert({ id, text, images, article_index }) {
      const t = now();
      const row = { id, seq: ++maxSeq, text, images: images ?? null, status: "pending", reply: null, error: null, created_at: t, updated_at: t, article_index: article_index ?? null };
      rows.set(id, row);
      return { ...row };
    },
    get(id) { const r = rows.get(id); return r ? { ...r } : null; },
    nextPending() {
      let best = null;
      for (const r of rows.values()) if (r.status === "pending" && (!best || r.seq < best.seq)) best = r;
      return best ? { ...best } : null;
    },
    markRunning(id) { const r = rows.get(id); if (r) { r.status = "running"; r.updated_at = now(); } },
    markDone(id, reply) { const r = rows.get(id); if (r) { r.status = "done"; r.reply = reply ?? null; r.updated_at = now(); } },
    markError(id, error) { const r = rows.get(id); if (r) { r.status = "error"; r.error = error ?? null; r.updated_at = now(); } },
    list() { return [...rows.values()].sort((a, b) => a.seq - b.seq).map((r) => ({ ...r })); },
    resetRunning() { for (const r of rows.values()) if (r.status === "running") { r.status = "pending"; r.updated_at = now(); } },
  };
}

// SQLite store backed by the DO's tagged-template `sql`. Same interface as
// makeMemStore. `sql` must be bound to the DO (e.g. this.sql.bind(this)).
export function makeSqlStore(sql, now = () => Date.now()) {
  return {
    insert({ id, text, images, article_index }) {
      const seq = (sql`SELECT COALESCE(MAX(seq),0) AS m FROM queue`[0]?.m || 0) + 1;
      const t = now();
      sql`INSERT INTO queue (id, seq, text, images, status, reply, error, created_at, updated_at, article_index)
          VALUES (${id}, ${seq}, ${text}, ${images ?? null}, 'pending', NULL, NULL, ${t}, ${t}, ${article_index ?? null})`;
      return this.get(id);
    },
    get(id) { return sql`SELECT * FROM queue WHERE id = ${id}`[0] || null; },
    nextPending() { return sql`SELECT * FROM queue WHERE status = 'pending' ORDER BY seq ASC LIMIT 1`[0] || null; },
    markRunning(id) { sql`UPDATE queue SET status='running', updated_at=${now()} WHERE id=${id}`; },
    markDone(id, reply) { sql`UPDATE queue SET status='done', reply=${reply ?? null}, updated_at=${now()} WHERE id=${id}`; },
    markError(id, error) { sql`UPDATE queue SET status='error', error=${error ?? null}, updated_at=${now()} WHERE id=${id}`; },
    list() { return [...sql`SELECT * FROM queue ORDER BY seq ASC`]; },
    resetRunning() { sql`UPDATE queue SET status='pending', updated_at=${now()} WHERE status='running'`; },
  };
}

export class ArticleQueue {
  constructor({ store, runTurn, loadDoc, broadcast, schedule, now = () => Date.now() }) {
    this.store = store;
    this.runTurn = runTurn;
    this.loadDoc = loadDoc;
    this.broadcast = broadcast;
    this.schedule = schedule || (() => {});
    this.now = now;
    this._draining = false;
  }

  // Idempotent enqueue. New id → inserted (caller arms a drain). Known id →
  // 'replay' with the existing row (caller re-pushes its cached result).
  async submit({ id, text, images, article_index }) {
    const existing = this.store.get(id);
    if (existing) return { kind: "replay", row: existing };
    this.store.insert({ id, text, images: images ? JSON.stringify(images) : null, article_index });
    return { kind: "enqueued" };
  }

  snapshot() {
    return this.store.list().map((r) => ({ id: r.id, text: r.text, status: r.status }));
  }

  // Reset rows a crashed/evicted DO left 'running'; report whether a drain is due.
  recover() {
    this.store.resetRunning();
    return !!this.store.nextPending();
  }

  // Process pending rows FIFO until none remain. One drain at a time per instance.
  async drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      for (let row = this.store.nextPending(); row; row = this.store.nextPending()) {
        await this._runRow(row);
      }
    } finally {
      this._draining = false;
    }
  }

  async _runRow(row) {
    // Crash-safe exactly-once: if the article already carries this id, the effect
    // already landed — mark done and re-broadcast without re-running the model.
    // Best-effort: a loadDoc() failure (transient storage error) must not abort the
    // drain nor permanently error the row — fall through and run the turn normally.
    let pre = null;
    try { pre = await this.loadDoc(); } catch (_) { pre = null; }
    if (pre && pre.lastEditId === row.id) {
      this.store.markDone(row.id, row.reply || "（已完成）");
      this.broadcast({ type: "updated", id: row.id, article: pre });
      if (row.reply) this.broadcast({ type: "reply", id: row.id, text: row.reply, ok: true });
      return;
    }
    this.store.markRunning(row.id);
    this.broadcast({ type: "status", state: "working", id: row.id });
    let res;
    try { res = await this.runTurn(row); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (res && res._pending) {
      // Destructive action staged, awaiting the user's confirm/cancel. runTurn already
      // broadcast the `confirm` message. Do NOT markDone and do NOT broadcast updated/reply —
      // the row stays 'running' so drain won't re-pick it this pass; on DO restart, recover()
      // flips it back to pending and re-runs → re-stages + re-broadcasts confirm (no orphan).
      return;
    }
    if (res && res.ok) {
      this.store.markDone(row.id, res.reply || "");
      this.broadcast({ type: "updated", id: row.id, article: res.article });
      if (res.reply) this.broadcast({ type: "reply", id: row.id, text: res.reply, ok: true });
    } else {
      const msg = (res && res.error) || "操作没完成";
      this.store.markError(row.id, msg);
      this.broadcast({ type: "error", id: row.id, message: msg });
    }
  }
}
