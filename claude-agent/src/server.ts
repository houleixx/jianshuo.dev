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
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 30);
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
  return { id, title: title.slice(0, 80) || "(无标题)", updatedAt: st.mtimeMs, turns };
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

async function handleChat(req: IncomingMessage, res: ServerResponse, payload: any) {
  const message = String(payload?.message ?? "").trim();
  const sessionId = payload?.sessionId ? String(payload.sessionId) : undefined;
  if (!message) {
    res.writeHead(400).end("empty message");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Heartbeat keeps the proxied connection from idling out during quiet
  // stretches (e.g. a long-running Bash tool).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, 15000);

  let aborted = false;
  const ac = new AbortController();
  const q = query({
    prompt: message,
    options: {
      abortController: ac,
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: MAX_TURNS,
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  // Client navigated away / closed the tab → stop the agent. Listen on the
  // RESPONSE (not req: req 'close' fires as soon as the POST body is consumed),
  // and only abort if we hadn't already finished writing. String-prompt mode
  // doesn't support interrupt(); aborting the controller is the supported path.
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      ac.abort();
    }
  });

  try {
    for await (const msg of q as AsyncIterable<any>) {
      if (aborted) break;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init" && msg.session_id)
            sse(res, "session", { sessionId: msg.session_id });
          break;

        case "stream_event": {
          // Live text typing only — tool calls come from the complete
          // assistant message below (so we get full, parsed tool input).
          const ev = msg.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta")
            sse(res, "text", { delta: ev.delta.text });
          break;
        }

        case "assistant": {
          for (const block of msg.message?.content ?? [])
            if (block.type === "tool_use")
              sse(res, "tool_use", { id: block.id, name: block.name, input: block.input });
          break;
        }

        case "user": {
          const content = msg.message?.content;
          if (Array.isArray(content))
            for (const block of content)
              if (block.type === "tool_result")
                sse(res, "tool_result", {
                  id: block.tool_use_id,
                  isError: !!block.is_error,
                  content: renderToolResult(block.content),
                });
          break;
        }

        case "result":
          sse(res, "result", {
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
    sse(res, "error", { message: err?.message ?? String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!aborted) sse(res, "done", {});
    res.end();
  }
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
