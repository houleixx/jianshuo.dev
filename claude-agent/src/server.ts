/**
 * Claude Agent SDK — persistent web-chat backend.
 *
 * A tiny dependency-free HTTP server that runs the Claude Code agent loop via
 * `query()` and streams its events to the browser over SSE. Auth (a single
 * password) is handled by the Caddy reverse proxy in front of this; the server
 * itself only listens on localhost and trusts Caddy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const WORKSPACE = process.env.WORKSPACE ?? join(__dirname, "..", "workspace");
const MODEL = process.env.MODEL ?? "claude-opus-4-8";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 100);
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
const MAX_RESULT_CHARS = 8000;

// The SDK persists each conversation as <session_id>.jsonl under HOME/.claude/projects/<cwd-slug>/.
const PROJECTS_DIR = join(process.env.HOME ?? homedir(), ".claude", "projects");
const SESSION_ID_RE = /^[a-f0-9-]{36}$/;

const INDEX_HTML = await readFile(join(__dirname, "..", "public", "index.html"), "utf8");

// A persistent service must survive a single bad query. The SDK fires internal
// promises we don't directly await; if one rejects after a request ends, log it
// instead of letting it take down the whole server.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

function sse(res: ServerResponse, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function renderToolResult(content: any): string {
  let out: string;
  if (typeof content === "string") out = content;
  else if (Array.isArray(content))
    out = content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
  else out = content == null ? "" : JSON.stringify(content);
  return out.length > MAX_RESULT_CHARS ? out.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]" : out;
}

// --- session history (read the SDK's on-disk transcripts) ---

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
  return "";
}

function isToolResult(content: any): boolean {
  return Array.isArray(content) && content.some((b) => b?.type === "tool_result");
}

async function findTranscript(id: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, id + ".jsonl");
    try {
      await stat(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function summarize(path: string, id: string) {
  const raw = await readFile(path, "utf8");
  let title = "";
  let turns = 0;
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "user" && !isToolResult(o.message?.content)) {
      const t = textOf(o.message?.content).trim();
      if (t) {
        turns++;
        if (!title) title = t;
      }
    }
  }
  const st = await stat(path);
  return { id, title: title.slice(0, 80) || "(无标题)", updatedAt: st.mtimeMs, turns, running: isRunning(id) };
}

async function listSessions() {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = await readdir(join(PROJECTS_DIR, d));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        out.push(await summarize(join(PROJECTS_DIR, d, f), f.slice(0, -6)));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

// Replay a transcript into the same shape the live UI renders: one assistant
// bubble per human turn, with text + tool cards (results attached) interleaved.
async function getSessionMessages(id: string) {
  const path = await findTranscript(id);
  if (!path) return null;
  const raw = await readFile(path, "utf8");
  const msgs: any[] = [];
  let cur: any = null;
  const toolIndex: Record<string, any> = {};
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "user") {
      const c = o.message?.content;
      if (isToolResult(c)) {
        for (const b of c)
          if (b.type === "tool_result" && toolIndex[b.tool_use_id]) {
            toolIndex[b.tool_use_id].result = renderToolResult(b.content);
            toolIndex[b.tool_use_id].isError = !!b.is_error;
          }
      } else {
        const t = textOf(c).trim();
        if (t) {
          msgs.push({ role: "user", text: t });
          cur = null;
        }
      }
    } else if (o.type === "assistant") {
      if (!cur) {
        cur = { role: "assistant", items: [] };
        msgs.push(cur);
      }
      for (const b of o.message?.content ?? []) {
        if (b.type === "text") cur.items.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          const item = { type: "tool", id: b.id, name: b.name, input: b.input, result: null, isError: false };
          cur.items.push(item);
          toolIndex[b.id] = item;
        }
      }
    }
  }
  return msgs;
}

// --- 写书 jobs (VoiceDrop app 实验功能「写书」) ---
//
// POST /api/book — fire-and-forget：验完 token 立刻 202，agent 在本进程后台跑完
// 整本书（skill 边写边发到 R2 books/，所以进程重启也只丢未过稿章节）。与 /api/chat
// 的「断线即中止」相反——app 提交完种子就可以关掉。
// 认证不走 Caddy basic_auth（Caddyfile 对此路径豁免）：客户端带 VoiceDrop 用户
// bearer（anon_*/session JWT），这里拿它去 jianshuo.dev whoami 验真——app 里零内置密钥。
const BOOK_MAX_TURNS = Number(process.env.BOOK_MAX_TURNS ?? 80);
const BOOK_DAILY_LIMIT = Number(process.env.BOOK_DAILY_LIMIT ?? 2);
const WHOAMI_URL = process.env.WHOAMI_URL ?? "https://jianshuo.dev/files/api/whoami";
const ARTICLES_URL = process.env.ARTICLES_URL ?? "https://jianshuo.dev/files/api/articles";
let bookJobRunning = false;
// per-scope 当日已写本数（进程内存，重启清零——1 核小机够用）
const bookQuota = new Map<string, { day: string; count: number }>();

// ⚠️ anon token 是客户端自造随机数，whoami 对任何格式正确的 token 都散列出
// scope 返回 200——所以 whoami 只提供归因，不是门槛。真门槛 = 该 scope 必须
// 已有成文文章（GET /articles 非空）：伪造 token 散列出的 scope 永远是空的，
// 全被挡掉；真用户得先录音成文才能写书。
async function verifyVoiceDropToken(auth: string | undefined): Promise<string | null> {
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const [who, arts] = await Promise.all([
      fetch(WHOAMI_URL, { headers: { Authorization: auth } }),
      fetch(ARTICLES_URL, { headers: { Authorization: auth } }),
    ]);
    if (!who.ok || !arts.ok) return null;
    const scope = (await who.json() as any)?.scope;
    const articles = (await arts.json() as any)?.articles;
    if (typeof scope !== "string" || !Array.isArray(articles) || articles.length < 1) return null;
    return scope;
  } catch {
    return null;
  }
}

function underDailyQuota(scope: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const q = bookQuota.get(scope);
  return !q || q.day !== day || q.count < BOOK_DAILY_LIMIT;
}

function countBook(scope: string) {
  const day = new Date().toISOString().slice(0, 10);
  const q = bookQuota.get(scope);
  if (q && q.day === day) q.count += 1;
  else bookQuota.set(scope, { day, count: 1 });
}

function runBookJob(seed: string, scope: string) {
  bookJobRunning = true;
  console.log(`[book] start scope=${scope} seed=${seed.slice(0, 120).replace(/\n/g, " ")}`);
  const q = query({
    prompt: `用 wjs-voicedrop-writing-book skill 写一本书。种子：\n${seed}`,
    options: {
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: BOOK_MAX_TURNS,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  });
  (async () => {
    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === "result")
          console.log(
            `[book] done scope=${scope} turns=${msg.num_turns} cost=${msg.total_cost_usd}` +
              (msg.subtype !== "success" ? ` ERROR=${msg.subtype}` : ""),
          );
      }
    } catch (e) {
      console.error("[book] job failed", e);
    } finally {
      bookJobRunning = false;
    }
  })();
}

async function handleBook(req: IncomingMessage, res: ServerResponse, payload: any) {
  const json = { "Content-Type": "application/json" };
  const seed = String(payload?.seed ?? "").trim().slice(0, 20000);
  if (!seed) {
    res.writeHead(400, json).end(JSON.stringify({ error: "empty seed" }));
    return;
  }
  const scope = await verifyVoiceDropToken(req.headers.authorization);
  if (!scope) {
    res.writeHead(401, json).end(JSON.stringify({ error: "bad token" }));
    return;
  }
  if (payload?.dry) {
    // 认证链路探活，不起 job、不计额度（部署冒烟用）
    res.writeHead(200, json).end(JSON.stringify({ ok: true, dry: true, scope }));
    return;
  }
  if (!underDailyQuota(scope)) {
    res.writeHead(429, json).end(JSON.stringify({ error: "quota" }));
    return;
  }
  if (bookJobRunning) {
    res.writeHead(409, json).end(JSON.stringify({ error: "busy" }));
    return;
  }
  countBook(scope);
  runBookJob(seed, scope);
  res.writeHead(202, json).end(JSON.stringify({ ok: true }));
}

// --- chat runs（断线不中止） ---
//
// 每条用户消息起一个后台 Run：agent 事件先进内存缓冲，SSE 连接只是订阅者。
// 浏览器断开（锁屏/切后台/网络抖动）只是退订，agent 继续跑到完；重新打开
// 会话用 GET /api/chat/attach 回放缓冲 + 续看直播。显式停止走 POST /api/chat/stop。
type Run = {
  keys: Set<string>; // registry 键：起始 sessionId（resume 时）+ init 后的新 sessionId
  events: { event: string; data: any }[];
  listeners: Set<ServerResponse>;
  done: boolean;
  ac: AbortController;
};
const runs = new Map<string, Run>();
let pendingSeq = 0;
const RUN_LINGER_MS = 5 * 60 * 1000; // done 后保留一会儿，晚到的 attach 还能回放
const MAX_BUFFERED_EVENTS = 20000;

function isRunning(id: string): boolean {
  const r = runs.get(id);
  return !!r && !r.done;
}

function activeRunCount(): number {
  let n = 0;
  const seen = new Set<Run>();
  for (const r of runs.values())
    if (!r.done && !seen.has(r)) {
      seen.add(r);
      n++;
    }
  return n;
}

function emit(run: Run, event: string, data: any) {
  // 相邻 text delta 合并存储，几小时的长任务缓冲也不至于膨胀
  const last = run.events[run.events.length - 1];
  if (event === "text" && last?.event === "text") last.data.delta += data.delta;
  else {
    run.events.push({ event, data });
    if (run.events.length > MAX_BUFFERED_EVENTS)
      run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const res of run.listeners) sse(res, event, data);
}

function sseHead(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

// 一条只发错误就收尾的 SSE 响应（并发满 / 会话已在跑）
function sseReject(res: ServerResponse, message: string) {
  sseHead(res);
  sse(res, "error", { message });
  sse(res, "done", {});
  res.end();
}

function subscribe(run: Run, res: ServerResponse, replay: boolean) {
  sseHead(res);
  if (replay) for (const e of run.events) sse(res, e.event, e.data);
  if (run.done) {
    sse(res, "done", {});
    res.end();
    return;
  }
  run.listeners.add(res);
  // Heartbeat keeps the proxied connection from idling out during quiet
  // stretches (e.g. a long-running Bash tool).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, 15000);
  // 断开只退订，不 abort——run 在服务端继续
  res.on("close", () => {
    clearInterval(heartbeat);
    run.listeners.delete(res);
  });
}

function finishRun(run: Run) {
  run.done = true;
  for (const res of run.listeners) {
    sse(res, "done", {});
    res.end();
  }
  run.listeners.clear();
  const t = setTimeout(() => {
    for (const k of run.keys) if (runs.get(k) === run) runs.delete(k);
  }, RUN_LINGER_MS);
  t.unref?.();
}

function startRun(message: string, sessionId: string | undefined): Run {
  const key = sessionId ?? `pending-${++pendingSeq}`;
  const run: Run = { keys: new Set([key]), events: [], listeners: new Set(), done: false, ac: new AbortController() };
  runs.set(key, run);
  const q = query({
    prompt: message,
    options: {
      abortController: run.ac,
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: MAX_TURNS,
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "## 画图能力",
          "本机有 paint 出图工具（背后是 paint.jianshuo.dev 的 gpt-image-2 服务），用户要画图/生成图片/改图时直接用：",
          '  /opt/claude-agent/bin/paint "提示词" 输出.png              # 文生图',
          '  /opt/claude-agent/bin/paint "提示词" 输出.png --image 输入.jpg   # 改图',
          "可选: --size WxH(默认1024x1024，总像素须≥1024×640) --transparent --quality low|medium|high --format png|jpeg|webp",
          "出图通常 1-3 分钟，脚本会自己轮询到完成——调 Bash 时把 timeout 设到 600000ms，耐心等它跑完。",
          "成功后脚本打印 result_url（公开可访问的 https://paint.jianshuo.dev/results/… 链接），把这个链接给用户，浏览器点开就能看图。",
        ].join("\n"),
      },
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  (async () => {
    try {
      for await (const msg of q as AsyncIterable<any>) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              // resume 会派发新 session_id——两个键都指向本 run，attach 用哪个都行
              if (!run.keys.has(msg.session_id)) {
                run.keys.add(msg.session_id);
                runs.set(msg.session_id, run);
              }
              emit(run, "session", { sessionId: msg.session_id });
            }
            break;

          case "stream_event": {
            // Live text typing only — tool calls come from the complete
            // assistant message below (so we get full, parsed tool input).
            const ev = msg.event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta")
              emit(run, "text", { delta: ev.delta.text });
            break;
          }

          case "assistant": {
            for (const block of msg.message?.content ?? [])
              if (block.type === "tool_use")
                emit(run, "tool_use", { id: block.id, name: block.name, input: block.input });
            break;
          }

          case "user": {
            const content = msg.message?.content;
            if (Array.isArray(content))
              for (const block of content)
                if (block.type === "tool_result")
                  emit(run, "tool_result", {
                    id: block.tool_use_id,
                    isError: !!block.is_error,
                    content: renderToolResult(block.content),
                  });
            break;
          }

          case "result":
            emit(run, "result", {
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              durationMs: msg.duration_ms,
              isError: msg.subtype !== "success",
              ...(msg.subtype !== "success" ? { error: msg.subtype } : {}),
            });
            break;
        }
      }
    } catch (err: any) {
      emit(run, "error", {
        message: run.ac.signal.aborted ? "已手动停止" : (err?.message ?? String(err)),
      });
    } finally {
      finishRun(run);
    }
  })();
  return run;
}

async function handleChat(req: IncomingMessage, res: ServerResponse, payload: any) {
  const message = String(payload?.message ?? "").trim();
  const sessionId = payload?.sessionId ? String(payload.sessionId) : undefined;
  if (!message) {
    res.writeHead(400).end("empty message");
    return;
  }
  if (sessionId && isRunning(sessionId)) {
    sseReject(res, "该会话已有任务在运行，可先停止或等它完成");
    return;
  }
  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    sseReject(res, `同时最多运行 ${MAX_CONCURRENT_RUNS} 个任务，稍后再试`);
    return;
  }
  subscribe(startRun(message, sessionId), res, true);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "GET" && req.url === "/api/sessions") {
    listSessions()
      .then((list) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
      })
      .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
    return;
  }
  const sm = req.url?.match(/^\/api\/sessions\/([^/?]+)$/);
  if (sm) {
    const id = decodeURIComponent(sm[1]);
    if (!SESSION_ID_RE.test(id)) {
      res.writeHead(400).end("bad id");
      return;
    }
    if (req.method === "GET") {
      getSessionMessages(id)
        .then((msgs) => {
          if (!msgs) {
            res.writeHead(404).end("not found");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(msgs));
        })
        .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
      return;
    }
    if (req.method === "DELETE") {
      findTranscript(id)
        .then(async (p) => {
          if (!p) {
            res.writeHead(404).end("not found");
            return;
          }
          await unlink(p);
          res.writeHead(200).end("ok");
        })
        .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
      return;
    }
  }
  // 重连续看：回放该 run 已缓冲的事件，然后跟着直播到结束
  const am = req.url?.match(/^\/api\/chat\/attach\?session=([^&]+)$/);
  if (req.method === "GET" && am) {
    const id = decodeURIComponent(am[1]);
    const run = runs.get(id);
    if (!run) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("no run");
      return;
    }
    subscribe(run, res, true);
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat/stop") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "";
      try {
        id = String(JSON.parse(body || "{}").sessionId ?? "");
      } catch {
        /* fall through to 404 */
      }
      const run = runs.get(id);
      if (run && !run.done) {
        run.ac.abort();
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } else {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no active run"}');
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/book") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      handleBook(req, res, payload).catch((err) => {
        res.writeHead(500).end(String(err?.message ?? err));
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      handleChat(req, res, payload).catch((err) => {
        try {
          sse(res, "error", { message: String(err?.message ?? err) });
          res.end();
        } catch {
          /* ignore */
        }
      });
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`claude-agent on http://${HOST}:${PORT}  model=${MODEL}  workspace=${WORKSPACE}`);
});
