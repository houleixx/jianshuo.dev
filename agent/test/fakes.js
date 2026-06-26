// A Map-backed R2 bucket mock — only the methods our tools use.
export function fakeEnv(seed = {}) {
  const store = new Map(Object.entries(seed)); // key -> string value
  const FILES = {
    async get(key) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      return { text: async () => v, json: async () => JSON.parse(v) };
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
