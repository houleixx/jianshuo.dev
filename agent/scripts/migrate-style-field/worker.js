// One-time style-field migration runner. NEVER deploy this — run it against the
// production bucket through wrangler's own OAuth (no FILES_TOKEN needed):
//
//   cd agent/scripts/migrate-style-field
//   npx wrangler dev --remote --port 8823
//
// Both routes are CURSOR-PAGED (one R2 list page per request — a full sweep in one
// request 504s the remote preview). Loop until the x-next-cursor header / `cursor`
// field comes back empty:
//
//   # full raw backup FIRST
//   cursor=""; : > backup.ndjson
//   while :; do
//     curl -sG -D /tmp/h "localhost:8823/dump" --data-urlencode "cursor=$cursor" >> backup.ndjson
//     cursor=$(awk 'tolower($1)=="x-next-cursor:"{print $2}' /tmp/h | tr -d '\r')
//     [ -z "$cursor" ] && break
//   done
//
//   # then the same loop shape against POST /migrate?dry=1, then POST /migrate
//
// Sweeps every users/*/articles/*.json; transform logic is in transform.js.
import { migrateDoc } from "./transform.js";

// One R2 list page under users/, filtered to article JSONs.
// n is the raw page size (audio/photo keys count toward it too).
async function articlePage(env, cursor, n = 500) {
  const l = await env.FILES.list({
    prefix: "users/", limit: n, ...(cursor ? { cursor } : {}),
  });
  const keys = (l.objects || []).map((o) => o.key)
    .filter((k) => /\/articles\/[^/]+\.json$/.test(k));
  return { keys, cursor: l.truncated ? l.cursor : "" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") || "";

    if (url.pathname === "/dump") {
      const page = await articlePage(env, cursor);
      const lines = [];
      for (const key of page.keys) {
        const obj = await env.FILES.get(key);
        if (obj) lines.push(JSON.stringify({ key, raw: await obj.text() }));
      }
      return new Response(lines.length ? lines.join("\n") + "\n" : "", {
        headers: { "Content-Type": "application/x-ndjson", "X-Next-Cursor": page.cursor },
      });
    }

    if (url.pathname === "/migrate" && request.method === "POST") {
      const dry = url.searchParams.get("dry") === "1";
      const page = await articlePage(env, cursor);
      const changed = [], corrupt = [];
      for (const key of page.keys) {
        const obj = await env.FILES.get(key);
        if (!obj) continue;
        let doc;
        try { doc = JSON.parse(await obj.text()); } catch { corrupt.push(key); continue; }
        const r = migrateDoc(doc);
        if (!r.changed) continue;
        changed.push(key);
        if (!dry) {
          await env.FILES.put(key, JSON.stringify(r.doc), {
            httpMetadata: { contentType: "application/json" },
          });
        }
      }
      return Response.json(
        { dry, pageArticles: page.keys.length, changed, corrupt, cursor: page.cursor },
        { headers: { "X-Next-Cursor": page.cursor } },
      );
    }

    return new Response("routes: GET /dump · POST /migrate[?dry=1] — both take ?cursor=\n", { status: 404 });
  },
};
