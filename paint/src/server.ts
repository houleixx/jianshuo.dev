import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { JobStore, type Job } from "./store.js";
import { EventHub } from "./events.js";
import { Worker } from "./worker.js";
import { sweep } from "./cleanup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const VALID_FORMAT = new Set(["png", "jpeg", "webp"]);
const VALID_QUALITY = new Set(["low", "medium", "high", "auto"]);

// Direct-literal-IP SSRF guard for server-side image_url fetch. Blocks loopback,
// private, and link-local (incl. cloud metadata 169.254.x) hosts, including
// IPv4-mapped IPv6 literals (::ffff:a.b.c.d). NOTE: DNS-rebinding via a hostname
// that resolves to a private IP is NOT covered — acceptable for this single-user,
// token-gated internal tool (v1); revisit with a resolver if opened up. Exported for unit tests.
export function isBlockedHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d dotted, or ::ffff:aabb:ccdd hex) to its IPv4.
  const mapped = h.match(/^::ffff:(.+)$/i);
  if (mapped) {
    let v4 = mapped[1];
    const hex = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const n1 = parseInt(hex[1], 16), n2 = parseInt(hex[2], 16);
      v4 = `${(n1 >> 8) & 255}.${n1 & 255}.${(n2 >> 8) & 255}.${n2 & 255}`;
    }
    h = v4;
  }
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6-literal-only checks (must contain ':', so plain domains like fda.gov are safe)
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fd") || h.startsWith("fe80")) return true;
  }
  return false;
}

function bearerOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers["authorization"];
  if (!h?.startsWith("Bearer ")) return false;
  const got = Buffer.from(h.slice(7));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(s);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function createApp(cfg: Config, deps: { store: JobStore; hub: EventHub; worker: Worker }): Server {
  const { store, hub, worker } = deps;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // --- static results (public, unguessable) ---
      if (path.startsWith("/results/") && req.method === "GET") {
        const name = basename(path.slice("/results/".length));
        if (!name || name.includes("..") || name.includes("/")) return sendJson(res, 400, { error: "bad name" });
        const file = join(cfg.resultsDir, name);
        const ext = extname(name).toLowerCase();
        try {
          await stat(file);
        } catch {
          return sendJson(res, 404, { error: "not found" });
        }
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        createReadStream(file).on("error", () => { res.destroy(); }).pipe(res);
        return;
      }

      // --- index (behind Caddy basic_auth); inject API token ---
      if (path === "/" && req.method === "GET") {
        const html = (await readFile(join(__dirname, "..", "public", "index.html"), "utf8")).replace("__API_TOKEN__", cfg.apiToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- operational log (behind Caddy basic_auth, same as "/") ---
      if (path === "/log" && req.method === "GET") {
        const jobs = await store.list(200);
        const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
        const badge = (ok: boolean, txt: string) => `<span style="color:${ok ? "#15803d" : "#b91c1c"};font-weight:600">${esc(txt)}</span>`;
        const rows = jobs.map((j) => {
          const p = publicJob(j, cfg);
          const t = esc(j.createdAt);
          const st = badge(j.status === "done", j.status);
          const cb = j.callbackStatus
            ? badge(j.callbackStatus === "delivered", `${j.callbackStatus}${j.callbackAttempts ? "×" + j.callbackAttempts : ""}`)
            : `<span style="color:#9ca3af">—</span>`;
          const err = j.error ? `<div style="color:#b91c1c;font-size:12px">${esc(j.error.code)}: ${esc(j.error.message)}</div>` : "";
          const thumb = p.result_url ? `<a href="${esc(p.result_url)}" target="_blank"><img src="${esc(p.result_url)}" style="height:48px;border-radius:6px" loading="lazy"></a>` : "";
          return `<tr><td style="white-space:nowrap;color:#555">${t}</td><td>${esc(j.mode)}</td><td>${st}</td><td>${cb}</td><td style="max-width:420px;white-space:pre-wrap">${esc(j.prompt || "")}${err}</td><td>${thumb}</td></tr>`;
        }).join("");
        const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>paint log</title>
<style>body{font:14px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;background:#f7f7f8;color:#1a1a1a;margin:0;padding:20px}h1{font-size:17px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e6e6e9;border-radius:10px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;font-size:13px}th{background:#faf9f7;color:#666;font-weight:600}tr:last-child td{border-bottom:0}</style></head>
<body><h1>paint 任务日志 <span style="color:#888;font-weight:400">（最近 ${jobs.length} 条 · 出图 done/failed · 回调 delivered/failed/—）</span></h1>
<table><thead><tr><th>时间(UTC)</th><th>模式</th><th>出图</th><th>回调</th><th>提示词 / 错误</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- everything under /api requires bearer (SSE events path also accepts ?token=,
      // since browser EventSource cannot set an Authorization header) ---
      if (path.startsWith("/api/")) {
        const isSse = /^\/api\/jobs\/[^/]+\/events$/.test(path);
        const authed = bearerOk(req, cfg.apiToken) || (isSse && url.searchParams.get("token") === cfg.apiToken);
        if (!authed) return sendJson(res, 401, { error: "unauthorized" });

        // POST /api/jobs
        if (path === "/api/jobs" && req.method === "POST") {
          const raw = await readBody(req, Math.ceil(cfg.maxInputBytes * 1.4) + 1024 * 1024);
          let body: any;
          try { body = JSON.parse(raw.toString("utf8") || "{}"); }
          catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
          return await submitJob(body, cfg, store, worker, res);
        }
        // GET /api/jobs (list)
        if (path === "/api/jobs" && req.method === "GET") {
          const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
          const jobs = await store.list(limit);
          return sendJson(res, 200, { jobs: jobs.map((j) => publicJob(j, cfg)) });
        }
        // GET /api/jobs/:id  or  /api/jobs/:id/events
        const m = path.match(/^\/api\/jobs\/([^/]+)(\/events)?$/);
        if (m && req.method === "GET") {
          const id = m[1];
          if (m[2] === "/events") return await sseEvents(id, cfg, store, hub, res);
          const job = await store.get(id);
          if (!job) return sendJson(res, 404, { error: "not found" });
          return sendJson(res, 200, publicJob(job, cfg));
        }
        return sendJson(res, 404, { error: "not found" });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) sendJson(res, e?.message === "body too large" ? 413 : 500, { error: e?.message ?? "server error" });
    }
  });
}

async function submitJob(body: any, cfg: Config, store: JobStore, worker: Worker, res: ServerResponse): Promise<void> {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return sendJson(res, 400, { error: "prompt required" });
  if (prompt.length > cfg.maxPromptChars) return sendJson(res, 400, { error: "prompt too long" });

  const format = body.format ?? "png";
  const quality = body.quality ?? "high";
  if (!VALID_FORMAT.has(format)) return sendJson(res, 400, { error: "bad format" });
  if (!VALID_QUALITY.has(quality)) return sendJson(res, 400, { error: "bad quality" });
  const transparent = body.transparent === true;

  // XMP 溯源参数（spec: docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md）
  let xmpMeta: Record<string, string> | undefined;
  if (body.xmp_meta !== undefined) {
    if (typeof body.xmp_meta !== "object" || body.xmp_meta === null || Array.isArray(body.xmp_meta))
      return sendJson(res, 400, { error: "xmp_meta must be an object" });
    for (const [k, v] of Object.entries(body.xmp_meta)) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) return sendJson(res, 400, { error: `xmp_meta bad key: ${k}` });
      if (typeof v !== "string") return sendJson(res, 400, { error: "xmp_meta values must be strings" });
    }
    if (JSON.stringify(body.xmp_meta).length > 4096) return sendJson(res, 400, { error: "xmp_meta too large (4KB)" });
    xmpMeta = body.xmp_meta;
  }

  const id = randomUUID();
  let mode: "generate" | "edit" = "generate";
  let inputPath: string | undefined;

  const hasImage = typeof body.image_url === "string" || typeof body.image_b64 === "string";
  if (hasImage) {
    if (transparent) return sendJson(res, 400, { error: "transparent+edit not supported" });
    mode = "edit";
    await mkdir(cfg.inputsDir, { recursive: true });
    inputPath = join(cfg.inputsDir, `${id}.img`);
    try {
      if (typeof body.image_url === "string") {
        let target: URL;
        try { target = new URL(body.image_url); } catch { return sendJson(res, 400, { error: "image_url invalid" }); }
        if (target.protocol !== "http:" && target.protocol !== "https:") return sendJson(res, 400, { error: "image_url must be http(s)" });
        if (isBlockedHost(target.hostname)) return sendJson(res, 400, { error: "image_url host not allowed" });
        // redirect: "manual" — fetch follows redirects by default, so a 3xx from an
        // allowed host could redirect to a blocked target (e.g. cloud metadata) and
        // bypass isBlockedHost, which only checks the initial hostname. With "manual",
        // undici returns an opaqueredirect response (ok===false) for any 3xx, so it's
        // rejected below before we ever connect to the redirect target.
        const r = await fetch(target, { signal: AbortSignal.timeout(30000), redirect: "manual" });
        if (!r.ok || !r.body) return sendJson(res, 400, { error: `image_url fetch failed: ${r.status}` });
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of r.body as any) {
          total += (c as Uint8Array).length;
          if (total > cfg.maxInputBytes) return sendJson(res, 400, { error: "input image too large" });
          chunks.push(Buffer.from(c));
        }
        await writeFile(inputPath, Buffer.concat(chunks));
      } else {
        const buf = Buffer.from(body.image_b64, "base64");
        if (buf.length > cfg.maxInputBytes) return sendJson(res, 400, { error: "input image too large" });
        await writeFile(inputPath, buf);
      }
    } catch (e: any) {
      return sendJson(res, 400, { error: `input image error: ${e?.message ?? e}` });
    }
  }

  const job: Job = {
    id, status: "queued", mode, prompt,
    params: { size: body.size ?? "2K", format, quality, compression: body.compression, transparent },
    inputPath, percent: 0, error: null,
    callbackUrl: typeof body.callback_url === "string" ? body.callback_url : undefined,
    callbackToken: typeof body.callback_token === "string" ? body.callback_token : undefined,
    callbackMeta: body.callback_meta,
    xmpPrompt: body.xmp_prompt !== false,
    xmpMeta,
    createdAt: new Date().toISOString(),
  };
  await store.create(job);
  worker.enqueue(id);
  sendJson(res, 202, { job_id: id, status: "queued", poll_url: `/api/jobs/${id}`, events_url: `/api/jobs/${id}/events` });
}

function publicJob(j: Job, cfg: Config) {
  const ext = j.resultPath ? extname(j.resultPath).slice(1) : null;
  return {
    job_id: j.id, status: j.status, percent: j.percent, mode: j.mode,
    prompt: j.prompt,
    result_url: j.status === "done" && ext ? `${cfg.publicBaseUrl}/results/${j.id}.${ext}` : null,
    format: j.format ?? null, size: j.size ?? null, bytes: j.bytes ?? null,
    error: j.error ?? null, attempts: j.attempts ?? null,
    created_at: j.createdAt, done_at: j.doneAt ?? null,
  };
}

async function sseEvents(id: string, cfg: Config, store: JobStore, hub: EventHub, res: ServerResponse): Promise<void> {
  const exists = await store.get(id);
  if (!exists) return sendJson(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let ping: ReturnType<typeof setInterval>;
  const off = hub.subscribe(id, (event, data) => {
    send(event, data);
    if (event === "done" || event === "failed") { off(); clearInterval(ping); if (!res.writableEnded) res.end(); }
  });
  ping = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15000);
  res.on("close", () => { off(); clearInterval(ping); });
  // Re-read AFTER subscribing so a terminal event fired during this read isn't lost.
  const job = (await store.get(id)) ?? exists;
  send("progress", { percent: job.percent });
  if (job.status === "done") { off(); clearInterval(ping); send("done", publicJob(job, cfg)); if (!res.writableEnded) res.end(); }
  else if (job.status === "failed") { off(); clearInterval(ping); send("failed", { error: job.error }); if (!res.writableEnded) res.end(); }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await mkdir(cfg.jobsDir, { recursive: true });
  await mkdir(cfg.resultsDir, { recursive: true });
  await mkdir(cfg.inputsDir, { recursive: true });
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  for (const id of await store.recover()) worker.enqueue(id);
  setInterval(() => { sweep(store, cfg).then((r) => r.deleted && console.log(`[cleanup] removed ${r.deleted} expired jobs`)).catch((e) => console.error("[cleanup]", e)); }, 6 * 60 * 60 * 1000);
  const app = createApp(cfg, { store, hub, worker });
  app.listen(cfg.port, cfg.host, () => console.log(`paint listening on ${cfg.host}:${cfg.port}`));
}

// run main() only when executed directly (not when imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
