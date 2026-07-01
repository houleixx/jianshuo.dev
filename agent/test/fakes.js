import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A Map-backed R2 bucket mock — only the methods our tools use.
export function fakeEnv(seed = {}) {
  const store = new Map(Object.entries(seed)); // key -> string value
  const FILES = {
    async get(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      return { text: async () => v, json: async () => JSON.parse(v), body: v, httpMetadata: {} };
    },
    async put(key, value) { store.set(key, typeof value === "string" ? value : String(value)); },
    async head(key) { return store.has(key) ? {} : null; },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((k) => ({ key: k, size: store.get(k).length, uploaded: new Date(0) }));
      return { objects };
    },
    _store: store,
  };
  return { FILES };
}

// Route table: { "POST https://host/path": (req) => ({ ok, status, body }) }
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body });
    const handler = routes[`${method} ${url}`] || routes[String(url)];
    const r = handler ? handler({ url, init }) : { ok: false, status: 404, body: { error: "no route" } };
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

import Database from "better-sqlite3";

// Minimal D1-compatible handle backed by in-memory SQLite (real SQL).
export function fakeD1(migrationSql) {
  const db = new Database(":memory:");
  if (migrationSql) db.exec(migrationSql);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        run() { const r = stmt.run(...args); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
        first(col) { const row = stmt.get(...args); if (col != null) return row ? row[col] : null; return row ?? null; },
        all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
    batch(statements) {
      const results = [];
      const txn = db.transaction(() => {
        for (const s of statements) {
          results.push(s.run());
        }
      });
      txn();
      return results;
    },
    exec(sql) { db.exec(sql); return { count: 0 }; },
  };
}

// 读取 usage 相关全部迁移（0001 + 0002），供 fakeD1 建一个有 bucket 表的库。
export function usageSql() {
  const f = (name) => readFileSync(fileURLToPath(new URL("../migrations/" + name, import.meta.url)), "utf8");
  return f("0001_usage.sql") + "\n" + f("0002_buckets.sql");
}
