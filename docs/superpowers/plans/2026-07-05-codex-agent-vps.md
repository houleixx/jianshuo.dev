# codex.jianshuo.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Tokyo VPS 上用现有 Codex 订阅凭证开一个网页聊天 agent（codex.jianshuo.dev），形态与 lab.jianshuo.dev 同构。

**Architecture:** 零依赖 node HTTP 服务（`127.0.0.1:8789`，systemd 非特权用户）每条消息 spawn `codex exec --json`（续聊走 `codex exec resume <thread_id>`），JSONL 事件逐行翻译成 SSE 推给单文件网页；Caddy 做 HTTPS + basic_auth 网关。凭证与 paint 服务**共用同一个** `CODEX_HOME=/opt/paint/.codex`（组权限共享，绝不拷贝——refresh token 单点轮换）。

**Tech Stack:** Node 20+（零运行时依赖）、TypeScript、node:test（`--experimental-strip-types`）、Codex CLI（`@openai/codex`，VPS 全局安装）、Caddy、systemd。

Spec：`docs/superpowers/specs/2026-07-05-codex-agent-vps-design.md`

## Global Constraints

- 零运行时依赖（devDeps 只有 typescript + @types/node），照 `claude-agent/` 的架子
- 端口 **8789**（lab 8787、paint 8788 已占）
- 沙箱：`-s workspace-write` + `-c sandbox_workspace_write.network_access=true`，工作区 `/opt/codex-agent/workspace`
- `CODEX_HOME=/opt/paint/.codex`，通过 `codexauth` 组共享，**禁止拷贝 auth.json**
- 并发闸：同时最多 1 个 codex 进程，排队超时 60s
- 订阅 ToS 单用户：basic_auth 用户 `wjs`，独立新密码，存 iCloud「账户和密码」
- UI 浅色（用户偏好）
- `codex exec --json` 的事件 schema 以 VPS 实机录制的 fixture 为准（Task 4 校准）；translate() 必须防御式——不认识的事件行忽略，绝不 crash
- 本机 `~/.codex/auth.json` 已失效（refresh_token_reused），本地一切测试都走假 codex 桩，真实 CLI 只在 VPS 上碰

---

### Task 1: 脚手架 + `codex.ts`（参数构造 & 事件翻译，纯逻辑）

**Files:**
- Create: `codex-agent/package.json`, `codex-agent/tsconfig.json`
- Create: `codex-agent/src/codex.ts`
- Test: `codex-agent/test/codex.test.ts`

**Interfaces:**
- Produces:
  - `buildArgs(message: string, threadId: string | null, workspace: string): string[]`
  - `translate(line: string): { event: string; data: any }[]`
  - SSE 事件名约定（Task 2/3 依赖）：`session`（内部，含 `threadId`）、`text`、`thinking`、`cmd`、`files`、`result`、`error`

- [ ] **Step 1: 脚手架**

`codex-agent/package.json`：

```json
{
  "name": "codex-agent",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "node --test --experimental-strip-types test/"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "typescript": "^5.6.0"
  }
}
```

`codex-agent/tsconfig.json`（与 claude-agent 相同）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: 写失败的测试**

`codex-agent/test/codex.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, translate } from "../src/codex.ts";

const WS = "/opt/codex-agent/workspace";
const FLAGS = ["--json", "-s", "workspace-write", "-C", WS, "-c", "sandbox_workspace_write.network_access=true"];

test("buildArgs 新会话：exec + flags + prompt 收尾", () => {
  assert.deepEqual(buildArgs("你好", null, WS), ["exec", ...FLAGS, "你好"]);
});

test("buildArgs 续聊：exec resume <id> <prompt> + flags", () => {
  assert.deepEqual(buildArgs("继续", "t-123", WS), ["exec", "resume", "t-123", "继续", ...FLAGS]);
});

test("translate: thread.started → session(threadId)", () => {
  const out = translate(JSON.stringify({ type: "thread.started", thread_id: "t-9" }));
  assert.deepEqual(out, [{ event: "session", data: { threadId: "t-9" } }]);
});

test("translate: agent_message → text", () => {
  const out = translate(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答案是 2" } }));
  assert.deepEqual(out, [{ event: "text", data: { text: "答案是 2" } }]);
});

test("translate: command_execution → cmd，超长输出截断", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "ls -la", exit_code: 0, aggregated_output: "x".repeat(9000) },
  });
  const [o] = translate(line);
  assert.equal(o.event, "cmd");
  assert.equal(o.data.command, "ls -la");
  assert.equal(o.data.exitCode, 0);
  assert.ok(o.data.output.length < 8100);
  assert.ok(o.data.output.endsWith("…[truncated]"));
});

test("translate: file_change → files", () => {
  const out = translate(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.txt", kind: "add" }] } }));
  assert.deepEqual(out, [{ event: "files", data: { changes: [{ path: "a.txt", kind: "add" }] } }]);
});

test("translate: turn.completed → result；turn.failed / error → error", () => {
  assert.deepEqual(translate(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } })), [
    { event: "result", data: { usage: { input_tokens: 5 } } },
  ]);
  assert.equal(translate(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }))[0].event, "error");
  assert.equal(translate(JSON.stringify({ type: "error", message: "bad" }))[0].event, "error");
});

test("translate: 空行 / 非 JSON / 不认识的事件 → []", () => {
  assert.deepEqual(translate(""), []);
  assert.deepEqual(translate("codex started"), []);
  assert.deepEqual(translate(JSON.stringify({ type: "item.started", item: { type: "agent_message" } })), []);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ~/code/jianshuo.dev/codex-agent && npm i && npm test 2>&1 | tail -5`
Expected: FAIL，`Cannot find module '../src/codex.ts'`

- [ ] **Step 4: 实现 `src/codex.ts`**

```ts
/**
 * codex exec 的参数构造 + `--json` JSONL 事件 → SSE 事件的翻译。
 * 真实事件 schema 以 VPS 实机录制的 fixture 为准（见 test/fixtures/README）；
 * 翻译必须防御式：认识的翻译，不认识的忽略，任何一行都不许把服务弄崩。
 */
const MAX_OUTPUT_CHARS = 8000;

export function buildArgs(message: string, threadId: string | null, workspace: string): string[] {
  const flags = [
    "--json",
    "-s", "workspace-write",
    "-C", workspace,
    "-c", "sandbox_workspace_write.network_access=true",
  ];
  if (threadId) return ["exec", "resume", threadId, message, ...flags];
  return ["exec", ...flags, message];
}

export function translate(line: string): { event: string; data: any }[] {
  const t = line.trim();
  if (!t) return [];
  let ev: any;
  try {
    ev = JSON.parse(t);
  } catch {
    return [];
  }
  const out: { event: string; data: any }[] = [];
  const type = String(ev?.type ?? "");
  const threadId = ev?.thread_id ?? ev?.session_id;
  if (threadId && (type === "thread.started" || type === "session.created")) {
    out.push({ event: "session", data: { threadId } });
  }
  const item = ev?.item;
  if (type === "item.completed" && item) {
    switch (item.type) {
      case "agent_message":
        if (item.text) out.push({ event: "text", data: { text: item.text } });
        break;
      case "reasoning":
        if (item.text) out.push({ event: "thinking", data: { text: item.text } });
        break;
      case "command_execution":
        out.push({
          event: "cmd",
          data: {
            command: item.command ?? "",
            exitCode: item.exit_code ?? null,
            output: clip(String(item.aggregated_output ?? item.output ?? "")),
          },
        });
        break;
      case "file_change":
        out.push({ event: "files", data: { changes: item.changes ?? [] } });
        break;
      case "error":
        out.push({ event: "error", data: { message: item.message ?? "unknown item error" } });
        break;
    }
  }
  if (type === "turn.completed") out.push({ event: "result", data: { usage: ev.usage ?? null } });
  if (type === "turn.failed" || type === "error") {
    out.push({ event: "error", data: { message: ev?.error?.message ?? ev?.message ?? "turn failed" } });
  }
  return out;
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…[truncated]" : s;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test 2>&1 | tail -5`
Expected: 全部 pass

- [ ] **Step 6: Commit**

```bash
git add codex-agent/package.json codex-agent/tsconfig.json codex-agent/src/codex.ts codex-agent/test/codex.test.ts
git commit -m "feat(codex-agent): 参数构造 + JSONL→SSE 翻译（纯逻辑，可单测）"
```

---

### Task 2: `server.ts` — SSE 服务 + 会话映射 + 并发闸

**Files:**
- Create: `codex-agent/src/server.ts`
- Create: `codex-agent/test/fixtures/fake-codex.mjs`
- Test: `codex-agent/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildArgs` / `translate`
- Produces:
  - `createApp(): http.Server`（测试用，`listen(0)` 随机端口）
  - `POST /api/chat` body `{chatId?, message}` → SSE 流，事件：`chat`（含 chatId，最先发）、
    `queued`、`text`、`thinking`、`cmd`、`files`、`result`、`error`、`session_reset`、`done`
  - `GET /` 返回 `public/index.html`；`GET /health` 返回 `ok`
  - 环境变量：`PORT`(8789) `HOST`(127.0.0.1) `WORKSPACE` `CODEX_BIN`(codex) `SESSIONS_FILE`

- [ ] **Step 1: 写假 codex 桩**

`codex-agent/test/fixtures/fake-codex.mjs`：

```js
#!/usr/bin/env node
// 打桩版 codex exec：不联网。按真实 --json 的 JSONL 形状吐事件。
// - `exec resume <id> <prompt>` → thread_id 沿用 <id>，回声里带 "resumed:<id>"
// - prompt 含 "CMD"  → 多吐一条 command_execution
// - prompt 含 "FAIL" → turn.failed + 退出码 1
// - prompt 含 "SLOW" → 出结果前睡 300ms（测并发闸用）
const args = process.argv.slice(2);
const isResume = args[0] === "exec" && args[1] === "resume";
const threadId = isResume ? args[2] : "t-fake-0001";
const positional = args.filter((a, i) => !a.startsWith("-") && !["exec", "resume"].includes(a) && !(args[i - 1] ?? "").match(/^(-s|-C|-c)$/));
const prompt = positional[positional.length - 1] ?? "";

const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
line({ type: "thread.started", thread_id: threadId });

if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 300));

if (prompt.includes("FAIL")) {
  line({ type: "turn.failed", error: { message: "stub turn failure" } });
  process.exit(1);
}
if (prompt.includes("CMD")) {
  line({ type: "item.completed", item: { type: "command_execution", command: "echo hi", exit_code: 0, aggregated_output: "hi\n" } });
}
line({ type: "item.completed", item: { type: "agent_message", text: (isResume ? `resumed:${threadId} ` : "") + "echo: " + prompt } });
line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
process.exit(0);
```

- [ ] **Step 2: 写失败的测试**

`codex-agent/test/server.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE = resolve("test/fixtures/fake-codex.mjs");

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "codex-agent-"));
  process.env.CODEX_BIN = process.execPath;          // node
  process.env.CODEX_ARGS_PREFIX = FAKE;              // 见 server.ts：测试注入桩脚本
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.WORKSPACE = dir;
  const { createApp } = await import("../src/server.ts");
  const app = createApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base };
}

/** 读整条 SSE 流，返回 [{event,data}] */
async function sseAll(res: Response) {
  const text = await res.text();
  const out: { event: string; data: any }[] = [];
  for (const chunk of text.split("\n\n")) {
    const ev = chunk.match(/^event: (.+)$/m)?.[1];
    const data = chunk.match(/^data: (.+)$/m)?.[1];
    if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

test("新会话：chat(chatId) 先发，text 回声，done 收尾", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "你好" }) });
  const evs = await sseAll(res);
  assert.equal(evs[0].event, "chat");
  assert.ok(evs[0].data.chatId);
  const txt = evs.find((e) => e.event === "text");
  assert.equal(txt?.data.text, "echo: 你好");
  assert.equal(evs.at(-1)?.event, "done");
  app.close();
});

test("续聊：同 chatId 第二条消息走 resume（回声带 resumed:<threadId>）", async () => {
  const { app, base } = await boot();
  const r1 = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "第一句" }) });
  const chatId = (await sseAll(r1))[0].data.chatId;
  const r2 = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: "第二句" }) });
  const txt = (await sseAll(r2)).find((e) => e.event === "text");
  assert.ok(txt?.data.text.startsWith("resumed:t-fake-0001"), `got: ${txt?.data.text}`);
  app.close();
});

test("并发闸：第二个请求先收到 queued，最终也完成", async () => {
  const { app, base } = await boot();
  const p1 = fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "SLOW 一号" }) });
  await new Promise((r) => setTimeout(r, 50)); // 确保一号先占住
  const p2 = fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "二号" }) });
  const [e1, e2] = await Promise.all([p1.then(sseAll), p2.then(sseAll)]);
  assert.ok(e1.some((e) => e.event === "text"));
  assert.ok(e2.some((e) => e.event === "queued"), "二号应先排队");
  assert.ok(e2.some((e) => e.event === "text" && e.data.text === "echo: 二号"));
  app.close();
});

test("codex 失败：error 事件带 stderr/事件里的信息，仍 done 收尾", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "FAIL 掉" }) });
  const evs = await sseAll(res);
  assert.ok(evs.some((e) => e.event === "error"));
  assert.equal(evs.at(-1)?.event, "done");
  app.close();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test 2>&1 | tail -5`
Expected: server.test 全 FAIL（`Cannot find module '../src/server.ts'`），codex.test 仍 pass

- [ ] **Step 4: 实现 `src/server.ts`**

```ts
/**
 * codex-agent —— Codex 订阅版网页聊天后端。
 * 每条消息 spawn 一次 `codex exec --json`（续聊 `codex exec resume <thread_id>`），
 * JSONL 事件经 translate() 翻成 SSE。认证由前置 Caddy basic_auth 负责，
 * 本服务只监听 localhost。1GB 小机：并发闸限制同时 1 个 codex 进程。
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
    if (!res.writableEnded) { sse(res, "done", {}); res.end(); }
    return;
  }

  const threadId = sessions[chatId] ?? null;
  const child = spawn(CODEX_BIN, [...ARGS_PREFIX, ...buildArgs(message, threadId, WORKSPACE)], { env: process.env });

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
```

注意：`public/index.html` 要先存在一个占位（Task 3 才写真 UI），否则 `readFileSync` 抛错。本步先 `echo 'codex-agent' > public/index.html`。

- [ ] **Step 5: 跑测试确认通过**

Run: `mkdir -p public && echo 'codex-agent' > public/index.html && npm test 2>&1 | tail -5`
Expected: 全部 pass（codex.test + server.test）

- [ ] **Step 6: Commit**

```bash
git add codex-agent/src/server.ts codex-agent/test/server.test.ts codex-agent/test/fixtures/fake-codex.mjs codex-agent/public/index.html
git commit -m "feat(codex-agent): SSE 服务 + 会话映射落盘 + 单进程并发闸"
```

---

### Task 3: `public/index.html` — 单文件浅色聊天 UI

**Files:**
- Modify: `codex-agent/public/index.html`（替换占位）

**Interfaces:**
- Consumes: Task 2 的 SSE 事件（`chat`/`queued`/`text`/`thinking`/`cmd`/`files`/`result`/`error`/`session_reset`/`done`）

- [ ] **Step 1: 写 UI**

完整替换 `codex-agent/public/index.html`：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Codex · jianshuo.dev</title>
<style>
  :root { --bg:#FAFAF7; --card:#fff; --ink:#26231C; --ink2:#6E675A; --line:#E8E3D7; --accent:#0891A2; --err:#C2410C; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.65 -apple-system,"PingFang SC",sans-serif; display:flex; flex-direction:column; height:100dvh }
  header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--card) }
  header h1 { font-size:15px; margin:0; flex:1 } header h1 small { color:var(--ink2); font-weight:400 }
  header button { border:1px solid var(--line); background:var(--card); border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px }
  .msg { max-width:72ch; padding:10px 14px; border-radius:12px; white-space:pre-wrap; word-break:break-word }
  .user { align-self:flex-end; background:var(--accent); color:#fff }
  .bot  { align-self:flex-start; background:var(--card); border:1px solid var(--line) }
  .card { align-self:flex-start; max-width:min(72ch,100%); width:fit-content; border:1px solid var(--line); border-radius:10px;
    background:var(--card); font:12.5px/1.5 ui-monospace,Menlo,monospace; overflow-x:auto }
  .card .hd { padding:6px 10px; color:var(--ink2); border-bottom:1px solid var(--line) }
  .card pre { margin:0; padding:8px 10px; white-space:pre-wrap; word-break:break-all; max-height:240px; overflow-y:auto }
  .thinking { color:var(--ink2); font-size:13px; font-style:italic }
  .status { align-self:center; color:var(--ink2); font-size:12.5px }
  .error { align-self:stretch; background:#FBEDE4; border-left:3px solid var(--err); color:#7C2D12; padding:8px 12px; border-radius:0 8px 8px 0; font-size:13.5px }
  form { display:flex; gap:8px; padding:12px 16px calc(12px + env(safe-area-inset-bottom)); border-top:1px solid var(--line); background:var(--card) }
  textarea { flex:1; resize:none; border:1px solid var(--line); border-radius:10px; padding:10px 12px; font:inherit; height:44px; max-height:140px }
  form button { border:0; background:var(--accent); color:#fff; border-radius:10px; padding:0 18px; font-size:14px; cursor:pointer }
  form button:disabled { opacity:.5 }
</style>
</head>
<body>
<header>
  <h1>Codex <small>· workspace-write · Tokyo VPS</small></h1>
  <button id="newchat" type="button">新会话</button>
</header>
<div id="log"></div>
<form id="f">
  <textarea id="t" placeholder="给 Codex 发消息…" required></textarea>
  <button id="send" type="submit">发送</button>
</form>
<script>
const log = document.getElementById("log"), form = document.getElementById("f"),
      ta = document.getElementById("t"), sendBtn = document.getElementById("send");
let chatId = null, bot = null, statusEl = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const add = (e) => { log.appendChild(e); log.scrollTop = log.scrollHeight; return e; };
const setStatus = (t) => { if (!statusEl) statusEl = add(el("div","status")); statusEl.textContent = t; };
const clearStatus = () => { statusEl?.remove(); statusEl = null; };

document.getElementById("newchat").onclick = () => { chatId = null; log.innerHTML = ""; ta.focus(); };

const on = {
  chat: (d) => { chatId = d.chatId; },
  queued: () => setStatus("排队中…（前面还有一个任务）"),
  thinking: (d) => add(el("div","msg bot thinking", d.text)),
  text: (d) => { bot = add(el("div","msg bot", d.text)); },
  cmd: (d) => { const c = el("div","card"); c.appendChild(el("div","hd", `$ ${d.command}   → exit ${d.exitCode}`));
                const p = el("pre",null,d.output||""); c.appendChild(p); add(c); },
  files: (d) => add(el("div","card")).appendChild(el("div","hd","✎ " + (d.changes||[]).map(c=>`${c.kind??"edit"} ${c.path}`).join("  "))),
  result: () => {},
  session_reset: () => { chatId = null; add(el("div","status","（旧会话已过期，已自动开新会话）")); },
  error: (d) => add(el("div","error", d.message)),
};

form.onsubmit = async (e) => {
  e.preventDefault();
  const message = ta.value.trim();
  if (!message) return;
  ta.value = ""; sendBtn.disabled = true;
  add(el("div","msg user", message));
  setStatus("Codex 干活中…");
  try {
    const res = await fetch("/api/chat", { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chatId, message }) });
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream:true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.+)$/m)?.[1], data = chunk.match(/^data: (.+)$/m)?.[1];
        if (!ev || !data) continue;
        if (ev === "done") { clearStatus(); }
        else { if (ev === "text" || ev === "error") clearStatus(); on[ev]?.(JSON.parse(data)); }
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    clearStatus(); add(el("div","error","连接断了：" + err.message));
  } finally {
    clearStatus(); sendBtn.disabled = false; ta.focus();
  }
};
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
</script>
</body>
</html>
```

- [ ] **Step 2: 本地手测**

Run:
```bash
cd ~/code/jianshuo.dev/codex-agent && npm run build
CODEX_BIN=$(which node) CODEX_ARGS_PREFIX=$PWD/test/fixtures/fake-codex.mjs \
  SESSIONS_FILE=/tmp/codex-agent-sessions.json WORKSPACE=/tmp PORT=8789 node dist/server.js
```
浏览器开 `http://127.0.0.1:8789`：发「你好」→ 气泡回「echo: 你好」；发「CMD 试试」→ 出命令卡片；
发「FAIL」→ 红条；点「新会话」再发 → 回声不带 `resumed:`。测完 Ctrl-C。

- [ ] **Step 3: 全量测试仍过**

Run: `npm test 2>&1 | tail -3`
Expected: 全 pass（UI 不影响服务测试）

- [ ] **Step 4: Commit**

```bash
git add codex-agent/public/index.html
git commit -m "feat(codex-agent): 单文件浅色聊天 UI（命令卡片/排队/错误红条/新会话）"
```

---

### Task 4: 部署件 + 上线 + 实机校准

**Files:**
- Create: `codex-agent/deploy/codex-agent.service`, `codex-agent/deploy/Caddyfile.snippet`, `codex-agent/deploy/provision.sh`, `codex-agent/deploy.sh`
- Create: `codex-agent/README.md`
- Modify: 根 `.assetsignore` / `.pagesignore`（加 `codex-agent/`，别让主站部署带上它）

**Interfaces:**
- Consumes: Task 1-3 的完整服务
- Produces: 线上 https://codex.jianshuo.dev

- [ ] **Step 1: systemd unit**

`codex-agent/deploy/codex-agent.service`：

```ini
[Unit]
Description=codex-agent - Codex subscription web chat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-agent
Group=codex-agent
WorkingDirectory=/opt/codex-agent
Environment=NODE_ENV=production
Environment=HOME=/opt/codex-agent
# 与 paint 共用同一份订阅凭证（组权限共享，见 provision.sh）。绝不拷贝这份文件。
Environment=CODEX_HOME=/opt/paint/.codex
EnvironmentFile=-/opt/codex-agent/.env
ExecStart=/usr/bin/node /opt/codex-agent/dist/server.js
Restart=always
RestartSec=3

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/codex-agent /opt/paint/.codex
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Caddy 段**

`codex-agent/deploy/Caddyfile.snippet`（provision 时追加到 `/etc/caddy/Caddyfile`）：

```
codex.jianshuo.dev {
	encode gzip

	basic_auth {
		wjs REPLACE_WITH_BCRYPT_HASH
	}

	reverse_proxy 127.0.0.1:8789 {
		flush_interval -1
	}
}
```

- [ ] **Step 3: provision.sh**

`codex-agent/deploy/provision.sh`：

```bash
#!/usr/bin/env bash
# 首次开服 —— 在 VPS 上以 root 跑，幂等。
# Node/Caddy 这台机器已有（lab/paint 装的），这里只补 codex CLI、用户/组、凭证组权限、unit。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▸ codex CLI"
command -v codex >/dev/null || npm i -g @openai/codex
codex --version

echo "▸ user + group"
id -u codex-agent >/dev/null 2>&1 || useradd --system --home /opt/codex-agent --shell /usr/sbin/nologin codex-agent
getent group codexauth >/dev/null || groupadd --system codexauth
usermod -aG codexauth paint
usermod -aG codexauth codex-agent

echo "▸ 共享 CODEX_HOME 组权限（/opt/paint/.codex，谁刷新 token 都写回这一份）"
chgrp -R codexauth /opt/paint/.codex
chmod -R g+rwX /opt/paint/.codex
chmod g+s /opt/paint/.codex

echo "▸ dirs"
mkdir -p /opt/codex-agent/workspace
chown -R codex-agent:codex-agent /opt/codex-agent

echo "▸ systemd unit"
install -m 644 "$HERE/codex-agent.service" /etc/systemd/system/codex-agent.service
systemctl daemon-reload
systemctl enable codex-agent >/dev/null

echo "▸ Caddy 段（手动步骤）"
echo "  1) caddy hash-password --plaintext '<新密码>'"
echo "  2) 把 $HERE/Caddyfile.snippet 换上 hash 后追加进 /etc/caddy/Caddyfile"
echo "  3) systemctl reload caddy"
echo "▸ DNS（手动步骤）：Cloudflare 加 A 记录 codex.jianshuo.dev → 66.42.45.128（灰云）"
echo "✓ provisioned"
```

- [ ] **Step 4: deploy.sh**

`codex-agent/deploy.sh`：

```bash
#!/usr/bin/env bash
# 本地 build → rsync → 重启。首次开服先跑 deploy/provision.sh。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/codex-agent}"

cd "$(dirname "$0")"
echo "▸ test + build"
npm test
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude workspace --exclude sessions.json --exclude '*.log' \
  dist public package.json deploy \
  "$VPS:$REMOTE/"

echo "▸ restart"
ssh "$VPS" "systemctl restart codex-agent && sleep 1 && systemctl --no-pager status codex-agent | head -8"
echo "✓ deployed"
```

（零运行时依赖，VPS 上不需要 `npm ci`。）

- [ ] **Step 5: 上线**

```bash
chmod +x codex-agent/deploy.sh codex-agent/deploy/provision.sh
# 1. provision（装 codex、建用户组、凭证组权限、unit）
rsync -az codex-agent/deploy root@66.42.45.128:/tmp/codex-agent-deploy/
ssh root@66.42.45.128 'bash /tmp/codex-agent-deploy/deploy/provision.sh'
# 2. Caddy：生成 hash、追加段、reload（密码用 openssl rand -base64 18 现生成，记 iCloud）
# 3. Cloudflare DNS：A codex.jianshuo.dev → 66.42.45.128（灰云；token 本机已配，走 API 加）
# 4. 部署
./codex-agent/deploy.sh
```

- [ ] **Step 6: 实机校准 translate()（关键步骤）**

VPS 上录一条真实事件流，对照 fixture 校准解析：

```bash
ssh root@66.42.45.128 'sudo -u codex-agent CODEX_HOME=/opt/paint/.codex \
  codex exec --json -s workspace-write -C /opt/codex-agent/workspace "只回答：1+1=?" ' \
  > codex-agent/test/fixtures/real-events.jsonl
```

- 逐行对照 `translate()` 的假设（`thread.started`/`item.completed`/`agent_message` 等字段名）；
  不一致处改 `src/codex.ts` 和 `fake-codex.mjs`，测试同步改，重跑 `npm test` 全过后再 `./deploy.sh`。
- 把 `real-events.jsonl` 提交进 repo 当权威 fixture，加一个测试：逐行喂给 `translate()`，
  断言至少产出一个 `session` 和一个 `text` 事件、全程不抛异常。

- [ ] **Step 7: 手测清单（手机 + 桌面浏览器过一遍）**

- [ ] https://codex.jianshuo.dev 弹密码框，`wjs` + 新密码进入
- [ ] 新会话问答（「介绍一下你自己」）
- [ ] 续聊上下文（「我刚才问了什么」）
- [ ] 跑命令写文件（「在工作区建一个 hello.txt 写入当前日期」→ 命令卡片 + 文件卡片）
- [ ] 区外写被拒（「往 /etc/hosts 追加一行」→ 应失败/被沙箱挡）
- [ ] 「新会话」按钮后上下文清空
- [ ] paint 服务不受影响：`curl -s https://paint.jianshuo.dev/健康检查` + 出一张图（凭证共享后两服务都能用）
- [ ] 手机 Safari 可用、键盘不遮输入框

- [ ] **Step 8: 收尾 Commit + 记忆**

```bash
git add codex-agent/ .assetsignore .pagesignore
git commit -m "feat(codex-agent): codex.jianshuo.dev 上线——Codex 订阅版远程 agent 网页聊天"
```

- README.md 写：URL、架构一句话、部署/排查命令（`journalctl -u codex-agent -n 50`）、
  凭证共享约定（绝不拷贝 auth.json）
- 新增记忆文件 `jianshuo-memory/08-infrastructure/codex-jianshuo-dev-agent.md` + 更新总索引
- 提醒用户：把网页密码记进 iCloud「账户和密码」文档
