/**
 * codex-agent —— Codex 订阅版网页聊天后端。
 * 每条消息 spawn 一次 `codex exec --json`（续聊 `codex exec resume <thread_id>`），
 * JSONL 事件经 translate() 翻成 SSE。认证由前置 Caddy basic_auth 负责，
 * 本服务只监听 localhost。1GB 小机：并发闸限制同时 1 个 codex 进程。
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { buildArgs, translate } from "./codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8789);
const HOST = process.env.HOST ?? "127.0.0.1";
const WORKSPACE = process.env.WORKSPACE ?? "/opt/codex-agent/workspace";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
// 测试注入：CODEX_ARGS_PREFIX=<桩脚本路径>，真实部署不设
const ARGS_PREFIX = process.env.CODEX_ARGS_PREFIX ? [process.env.CODEX_ARGS_PREFIX] : [];
const SESSIONS_FILE = process.env.SESSIONS_FILE ?? "/opt/codex-agent/sessions.json";
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS ?? 60_000);

const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

// --- chatId → codex threadId 映射（内存 + 落盘） ---
let sessions: Record<string, string> = {};
try {
  sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
} catch {
  /* 首次启动没有文件 */
}
async function saveSessions(): Promise<void> {
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// --- 并发闸：同时最多 1 个 codex 进程 ---
let busy = false;
const waiters: (() => void)[] = [];
function acquire(onQueued: () => void): Promise<boolean> {
  if (!busy) {
    busy = true;
    return Promise.resolve(true);
  }
  onQueued();
  return new Promise((resolve) => {
    const grab = () => {
      clearTimeout(timer);
      busy = true;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(grab);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, QUEUE_TIMEOUT_MS);
    waiters.push(grab);
  });
}
function release(): void {
  busy = false;
  waiters.shift()?.();
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleChat(res: ServerResponse, payload: any): Promise<void> {
  const message = String(payload?.message ?? "").trim();
  if (!message) {
    res.writeHead(400).end("empty message");
    return;
  }
  const chatId = payload?.chatId ? String(payload.chatId) : randomUUID();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sse(res, "chat", { chatId });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, 15000);

  const got = await acquire(() => sse(res, "queued", {}));
  if (!got) {
    sse(res, "error", { message: "排队超时（前面的任务还没结束），稍后再试" });
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      sse(res, "done", {});
      res.end();
    }
    return;
  }

  const threadId = sessions[chatId] ?? null;
  // stdin 必须 ignore：codex exec 见到管道 stdin 会等 EOF（实机验证过会挂住）
  const child = spawn(CODEX_BIN, [...ARGS_PREFIX, ...buildArgs(message, threadId, WORKSPACE)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrTail = "";
  child.stderr.on("data", (c) => {
    stderrTail = (stderrTail + c).slice(-4000);
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const o of translate(line)) {
      if (o.event === "session" && o.data?.threadId) {
        if (sessions[chatId] !== o.data.threadId) {
          sessions[chatId] = o.data.threadId;
          saveSessions().catch((e) => console.error("[sessions] save failed", e));
        }
        continue; // 内部记账，不推前端
      }
      sse(res, o.event, o.data);
    }
  });

  // 浏览器关页 → 杀子进程。听 res 的 close（lab 踩过的坑：req 的 close 在读完 body 就触发）
  res.on("close", () => {
    if (!res.writableEnded) child.kill("SIGTERM");
  });

  const code: number = await new Promise((r) => {
    child.on("close", (c) => r(c ?? 1));
    child.on("error", () => r(127));
  });
  release();
  clearInterval(heartbeat);

  if (code !== 0 && !res.writableEnded) {
    if (threadId && /not found|no rollout|unknown (session|thread)/i.test(stderrTail)) {
      // resume 的会话被 codex 清理了 → 丢掉映射，下条消息自动开新会话
      delete sessions[chatId];
      saveSessions().catch(() => {});
      sse(res, "session_reset", {});
    } else if (/refresh_token|401|unauthorized/i.test(stderrTail)) {
      sse(res, "error", { message: "Codex 凭证失效（可能被别处的拷贝踢掉了），需在 VPS 上重新 codex login" });
    } else {
      sse(res, "error", { message: stderrTail.slice(-800) || `codex 退出码 ${code}` });
    }
  }
  sse(res, "done", {});
  res.end();
}

export function createApp(): Server {
  return createServer((req, res) => {
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
        handleChat(res, payload).catch((err) => {
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
}

// 直接运行（非测试 import）时才监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(PORT, HOST, () => {
    console.log(`codex-agent on http://${HOST}:${PORT}  workspace=${WORKSPACE}`);
  });
}
