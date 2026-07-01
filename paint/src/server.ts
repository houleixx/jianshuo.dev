import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        createReadStream(file).on("error", () => { if (!res.headersSent) res.writeHead(404); res.end(); }).pipe(res);
        return;
      }

      // --- index (behind Caddy basic_auth); inject API token ---
      if (path === "/" && req.method === "GET") {
        const html = (await readFile(join(__dirname, "..", "public", "index.html"), "utf8")).replace("__API_TOKEN__", cfg.apiToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- everything under /api requires bearer ---
      if (path.startsWith("/api/")) {
        if (!bearerOk(req, cfg.apiToken)) return sendJson(res, 401, { error: "unauthorized" });

        // POST /api/jobs
        if (path === "/api/jobs" && req.method === "POST") {
          const raw = await readBody(req, cfg.maxInputBytes + 1024 * 1024);
          const body = JSON.parse(raw.toString("utf8") || "{}");
          return await submitJob(body, cfg, store, worker, res);
        }
        // GET /api/jobs (list)
        if (path === "/api/jobs" && req.method === "GET") {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
          const jobs = await store.list(limit);
          return sendJson(res, 200, { jobs: jobs.map((j) => publicJob(j, cfg)) });
        }
        // GET /api/jobs/:id  or  /api/jobs/:id/events
        const m = path.match(/^\/api\/jobs\/([^/]+)(\/events)?$/);
        if (m && req.method === "GET") {
          const id = m[1];
          const job = await store.get(id);
          if (!job) return sendJson(res, 404, { error: "not found" });
          if (m[2] === "/events") return sseEvents(id, job, cfg, store, hub, res);
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
        if (!/^https?:\/\//.test(body.image_url)) return sendJson(res, 400, { error: "image_url must be http(s)" });
        const r = await fetch(body.image_url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) return sendJson(res, 400, { error: `image_url fetch failed: ${r.status}` });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > cfg.maxInputBytes) return sendJson(res, 400, { error: "input image too large" });
        await writeFile(inputPath, buf);
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
    error: j.error ?? null, created_at: j.createdAt, done_at: j.doneAt ?? null,
  };
}

function sseEvents(id: string, job: Job, cfg: Config, store: JobStore, hub: EventHub, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  // replay current state first
  send("progress", { percent: job.percent });
  if (job.status === "done") { send("done", publicJob(job, cfg)); res.end(); return; }
  if (job.status === "failed") { send("failed", { error: job.error }); res.end(); return; }

  const off = hub.subscribe(id, (event, data) => {
    send(event, data);
    if (event === "done" || event === "failed") { off(); clearInterval(ping); res.end(); }
  });
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15000);
  res.on("close", () => { off(); clearInterval(ping); });
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
