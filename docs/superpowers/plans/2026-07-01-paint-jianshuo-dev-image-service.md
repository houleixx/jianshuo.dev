# paint.jianshuo.dev 图片服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Tokyo VPS 上常驻一个网页 + HTTP API 服务，用 Codex 订阅跑 gpt-image-2，异步出图并支持带参数 webhook 回调。

**Architecture:** 纯 `node:*`（零运行时依赖）的 TypeScript HTTP 服务，外壳照抄 `claude-agent`（Caddy HTTPS + basic_auth + systemd）。job 用「一 job 一 JSON 文件」落盘（不引 SQLite），图像生成 spawn 外部 `gpt-image-2-skill --provider codex` CLI。请求提交即返回 `job_id`；网页走 SSE 看进度，程序走轮询 + 回调。

**Tech Stack:** Node 20 + TypeScript（ESM, `tsc`→`dist`, NodeNext）；测试用 Node 内置 `node:test` + `tsx`；外部 CLI `gpt-image-2-skill`（npm 全局）；Caddy + systemd。

## Global Constraints

- 目录：`~/code/jianshuo.dev/paint/`；VPS 部署到 `/opt/paint`，监听 `127.0.0.1:8788`（8787 已被 claude-agent 占）。
- 子域 `paint.jianshuo.dev`，Cloudflare **灰云** A → `66.42.45.128`，不走 Pages。加进根 `.assetsignore` + `.pagesignore`。
- **零运行时依赖**：只用 `node:*` 内置模块。devDeps 仅 `typescript`、`@types/node`、`tsx`。
- ESM：src 内部相对 import **必须带 `.js` 后缀**（NodeNext 要求）；测试用 tsx，import src 时写 `.ts` 后缀。
- Codex only 参数：只暴露 `--size/--quality/--format/--compression`；不暴露 `--background/--n/--mask`（Codex 不认）。
- 结果路径由服务用 `--out` 指定，**成功与否只看 `ok` + 文件是否存在**，大小从磁盘 `stat` 读，不依赖 stdout 信封里 `output` 的形状。
- `--json` 结果在 **stdout**，`--json-events` 进度在 **stderr**（JSONL 一行一事件）。
- 单用户订阅（ToS）：仅本人用，密码 + token 门禁，密钥只进 `/opt/paint/.env`（600），绝不进 git。
- 提交 commit message 结尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## File Structure

```
paint/
├── package.json              # 零 deps，scripts: build/start/test
├── tsconfig.json             # 照抄 claude-agent（NodeNext, outDir dist）
├── .gitignore                # dist node_modules .env data
├── .env.example              # 所有配置项样例
├── README.md                 # 简述 + 部署/排查
├── src/
│   ├── config.ts             # env → typed Config（纯函数，无副作用）
│   ├── store.ts              # Job 类型 + JobStore（一 job 一 JSON 文件）
│   ├── events.ts             # EventHub：按 job_id 的内存 pub/sub（SSE 用）
│   ├── engine.ts             # buildArgs / parseResult / parseEventLine（纯函数）
│   ├── callback.ts           # sign(HMAC) + deliver（重试，可注入 fetch/delay）
│   ├── worker.ts             # 并发池：spawn CLI → 更新 store/hub → 触发回调
│   ├── cleanup.ts            # sweep：清理超期 job + 文件
│   └── server.ts             # http 路由 + 鉴权 + SSE + 静态 + main()
├── public/
│   └── index.html            # 单文件浅色 UI（上传/生成/进度/历史）
├── deploy/
│   ├── Caddyfile
│   ├── paint.service
│   └── provision.sh
├── deploy.sh
└── test/
    ├── fixtures/fake-gpt-image-2-skill.mjs   # 打桩 CLI（不花 Codex 额度）
    ├── config.test.ts
    ├── store.test.ts
    ├── events.test.ts
    ├── engine.test.ts
    ├── callback.test.ts
    ├── worker.test.ts
    └── routes.test.ts
```

---

## Task 1: 项目骨架 + config

**Files:**
- Create: `paint/package.json`, `paint/tsconfig.json`, `paint/.gitignore`, `paint/.env.example`
- Create: `paint/src/config.ts`
- Test: `paint/test/config.test.ts`

**Interfaces:**
- Produces: `interface Config`（见下）；`function loadConfig(env?: NodeJS.ProcessEnv): Config`。

- [ ] **Step 1: 建 package.json**

`paint/package.json`：
```json
{
  "name": "paint",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: 建 tsconfig.json / .gitignore / .env.example**

`paint/tsconfig.json`：
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

`paint/.gitignore`：
```
node_modules
dist
.env
data
*.log
```

`paint/.env.example`：
```
PORT=8788
HOST=127.0.0.1
PUBLIC_BASE_URL=https://paint.jianshuo.dev
DATA_DIR=/opt/paint/data
API_TOKEN=replace-with-long-random-token
CALLBACK_SIGNING_SECRET=replace-with-long-random-secret
MAX_CONCURRENCY=3
RETENTION_DAYS=30
GPT_IMAGE_BIN=gpt-image-2-skill
CODEX_HOME=/opt/paint/.codex
MAX_INPUT_BYTES=26214400
MAX_PROMPT_CHARS=4000
```

- [ ] **Step 3: 装依赖**

Run: `cd paint && npm install`
Expected: 生成 `node_modules` + `package-lock.json`，无报错。

- [ ] **Step 4: 写失败测试**

`paint/test/config.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig reads values and derives dirs", () => {
  const cfg = loadConfig({
    API_TOKEN: "tok", CALLBACK_SIGNING_SECRET: "sec", DATA_DIR: "/tmp/paint-x",
  } as any);
  assert.equal(cfg.apiToken, "tok");
  assert.equal(cfg.callbackSigningSecret, "sec");
  assert.equal(cfg.jobsDir, "/tmp/paint-x/jobs");
  assert.equal(cfg.resultsDir, "/tmp/paint-x/results");
  assert.equal(cfg.inputsDir, "/tmp/paint-x/inputs");
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.maxConcurrency, 3);
});

test("loadConfig throws when secrets missing", () => {
  assert.throws(() => loadConfig({} as any), /API_TOKEN/);
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/config.ts`。

- [ ] **Step 6: 实现 config.ts**

`paint/src/config.ts`：
```ts
import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  dataDir: string;
  jobsDir: string;
  resultsDir: string;
  inputsDir: string;
  apiToken: string;
  callbackSigningSecret: string;
  maxConcurrency: number;
  retentionDays: number;
  gptImageBin: string;
  codexHome?: string;
  maxInputBytes: number;
  maxPromptChars: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.API_TOKEN;
  const callbackSigningSecret = env.CALLBACK_SIGNING_SECRET;
  if (!apiToken) throw new Error("Missing required env API_TOKEN");
  if (!callbackSigningSecret) throw new Error("Missing required env CALLBACK_SIGNING_SECRET");
  const dataDir = env.DATA_DIR ?? "/opt/paint/data";
  return {
    port: Number(env.PORT ?? 8788),
    host: env.HOST ?? "127.0.0.1",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "https://paint.jianshuo.dev").replace(/\/$/, ""),
    dataDir,
    jobsDir: join(dataDir, "jobs"),
    resultsDir: join(dataDir, "results"),
    inputsDir: join(dataDir, "inputs"),
    apiToken,
    callbackSigningSecret,
    maxConcurrency: Number(env.MAX_CONCURRENCY ?? 3),
    retentionDays: Number(env.RETENTION_DAYS ?? 30),
    gptImageBin: env.GPT_IMAGE_BIN ?? "gpt-image-2-skill",
    codexHome: env.CODEX_HOME,
    maxInputBytes: Number(env.MAX_INPUT_BYTES ?? 26214400),
    maxPromptChars: Number(env.MAX_PROMPT_CHARS ?? 4000),
  };
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（2 tests）。

- [ ] **Step 8: commit**

```bash
cd paint && git add package.json package-lock.json tsconfig.json .gitignore .env.example src/config.ts test/config.test.ts
git commit -m "feat(paint): 项目骨架 + config 加载

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Job 存储（JobStore）

**Files:**
- Create: `paint/src/store.ts`
- Test: `paint/test/store.test.ts`

**Interfaces:**
- Produces:
  - `type JobStatus = "queued" | "running" | "done" | "failed"`
  - `interface Job`（字段见下）
  - `class JobStore`：`constructor(dir: string)`；`create(job: Job): Promise<void>`；`get(id: string): Promise<Job | null>`；`update(id: string, patch: Partial<Job>): Promise<Job>`；`list(limit: number): Promise<Job[]>`（按 createdAt 倒序）；`recover(): Promise<string[]>`（把 running→queued，返回需重排队的 id）。

- [ ] **Step 1: 写失败测试**

`paint/test/store.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, type Job } from "../src/store.ts";

function sampleJob(id: string): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "cat",
    params: { size: "2K", format: "png", quality: "high", transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(),
  };
}

test("create/get roundtrip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  const got = await store.get("a1");
  assert.equal(got?.prompt, "cat");
  assert.equal(await store.get("missing"), null);
});

test("update merges patch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  const up = await store.update("a1", { status: "running", percent: 50 });
  assert.equal(up.status, "running");
  assert.equal(up.percent, 50);
  assert.equal((await store.get("a1"))?.percent, 50);
});

test("list sorted desc by createdAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create({ ...sampleJob("old"), createdAt: "2026-01-01T00:00:00Z" });
  await store.create({ ...sampleJob("new"), createdAt: "2026-02-01T00:00:00Z" });
  const list = await store.list(10);
  assert.deepEqual(list.map((j) => j.id), ["new", "old"]);
});

test("recover flips running to queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create({ ...sampleJob("r1"), status: "running" });
  await store.create({ ...sampleJob("q1"), status: "queued" });
  await store.create({ ...sampleJob("d1"), status: "done" });
  const ids = (await store.recover()).sort();
  assert.deepEqual(ids, ["q1", "r1"]);
  assert.equal((await store.get("r1"))?.status, "queued");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/store.ts`。

- [ ] **Step 3: 实现 store.ts**

`paint/src/store.ts`：
```ts
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  mode: "generate" | "edit";
  prompt: string;
  params: {
    size: string;
    format: string;
    quality: string;
    compression?: number;
    transparent: boolean;
  };
  inputPath?: string;
  resultPath?: string;
  format?: string;
  bytes?: number;
  size?: string;
  percent: number;
  error?: { code: string; message: string } | null;
  callbackUrl?: string;
  callbackToken?: string;
  callbackMeta?: unknown;
  callbackStatus?: "pending" | "delivered" | "failed";
  callbackAttempts?: number;
  lastCallbackAt?: string;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
}

export class JobStore {
  constructor(private dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(job: Job): Promise<void> {
    await this.ensureDir();
    await this.writeAtomic(job);
  }

  async get(id: string): Promise<Job | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Job;
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async update(id: string, patch: Partial<Job>): Promise<Job> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    const next = { ...cur, ...patch };
    await this.writeAtomic(next);
    return next;
  }

  async list(limit: number): Promise<Job[]> {
    await this.ensureDir();
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const jobs: Job[] = [];
    for (const f of files) {
      try {
        jobs.push(JSON.parse(await readFile(join(this.dir, f), "utf8")));
      } catch {
        /* skip unreadable */
      }
    }
    jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return jobs.slice(0, limit);
  }

  async recover(): Promise<string[]> {
    const all = await this.list(Number.MAX_SAFE_INTEGER);
    const ids: string[] = [];
    for (const j of all) {
      if (j.status === "queued" || j.status === "running") {
        if (j.status === "running") await this.update(j.id, { status: "queued", percent: 0 });
        ids.push(j.id);
      }
    }
    return ids;
  }

  private async writeAtomic(job: Job): Promise<void> {
    const tmp = this.path(`.${job.id}.tmp`);
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, this.path(job.id));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（config + store 全部）。

- [ ] **Step 5: commit**

```bash
cd paint && git add src/store.ts test/store.test.ts
git commit -m "feat(paint): Job 存储（一 job 一 JSON 文件）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 引擎参数与解析（engine）

**Files:**
- Create: `paint/src/engine.ts`
- Test: `paint/test/engine.test.ts`

**Interfaces:**
- Consumes: `Job` from `./store.js`。
- Produces:
  - `function buildArgs(job: Job, outPath: string): string[]`（transparent + edit 组合抛错）
  - `function parseResult(stdout: string): { ok: boolean; error?: { code: string; message: string } }`
  - `function parseEventLine(line: string): { percent?: number; phase?: string } | null`

- [ ] **Step 1: 写失败测试**

`paint/test/engine.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, parseResult, parseEventLine } from "../src/engine.ts";
import type { Job } from "../src/store.ts";

const base: Job = {
  id: "j1", status: "queued", mode: "generate", prompt: "a red cat",
  params: { size: "2K", format: "png", quality: "high", transparent: false },
  percent: 0, error: null, createdAt: "2026-07-01T00:00:00Z",
};

test("buildArgs generate", () => {
  const a = buildArgs(base, "/out/j1.png");
  assert.deepEqual(a, [
    "--json", "--json-events", "images", "generate", "--provider", "codex",
    "--prompt", "a red cat", "--out", "/out/j1.png",
    "--format", "png", "--size", "2K", "--quality", "high",
  ]);
});

test("buildArgs edit adds --ref-image", () => {
  const a = buildArgs({ ...base, mode: "edit", inputPath: "/in/j1.png" }, "/out/j1.png");
  assert.ok(a.includes("edit"));
  assert.ok(a.includes("--ref-image"));
  assert.equal(a[a.indexOf("--ref-image") + 1], "/in/j1.png");
});

test("buildArgs compression when set", () => {
  const a = buildArgs({ ...base, params: { ...base.params, format: "jpeg", compression: 80 } }, "/o.jpeg");
  assert.equal(a[a.indexOf("--compression") + 1], "80");
});

test("buildArgs transparent generate", () => {
  const a = buildArgs({ ...base, params: { ...base.params, transparent: true } }, "/out/j1.png");
  assert.deepEqual(a.slice(0, 5), ["--json", "--json-events", "transparent", "generate", "--provider"]);
});

test("buildArgs transparent+edit throws", () => {
  assert.throws(
    () => buildArgs({ ...base, mode: "edit", inputPath: "/in.png", params: { ...base.params, transparent: true } }, "/o.png"),
    /transparent.*edit/i
  );
});

test("parseResult success/error", () => {
  assert.deepEqual(parseResult('{"ok":true,"output":{"path":"/x"}}'), { ok: true });
  const r = parseResult('{"ok":false,"error":{"code":"http_error","message":"boom"}}');
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "http_error");
});

test("parseResult tolerates junk before json", () => {
  assert.equal(parseResult('warn line\n{"ok":true}').ok, true);
  assert.equal(parseResult("not json at all").ok, false);
});

test("parseEventLine maps percent, skips sse", () => {
  assert.deepEqual(
    parseEventLine('{"data":{"percent":95,"phase":"request_completed"},"kind":"progress","type":"request_completed"}'),
    { percent: 95, phase: "request_completed" }
  );
  assert.equal(parseEventLine('{"kind":"sse","type":"keepalive","data":{}}'), null);
  assert.equal(parseEventLine("garbage"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/engine.ts`。

- [ ] **Step 3: 实现 engine.ts**

`paint/src/engine.ts`：
```ts
import type { Job } from "./store.js";

export function buildArgs(job: Job, outPath: string): string[] {
  const { prompt, mode, params } = job;
  const common = ["--provider", "codex", "--prompt", prompt, "--out", outPath];
  const sizeQuality = ["--size", params.size, "--quality", params.quality];

  if (params.transparent) {
    if (mode === "edit") {
      throw new Error("transparent output is not supported for edit (transparent+edit)");
    }
    return ["--json", "--json-events", "transparent", "generate", ...common, ...sizeQuality];
  }

  const fmt = ["--format", params.format];
  const comp = params.compression != null ? ["--compression", String(params.compression)] : [];

  if (mode === "edit") {
    if (!job.inputPath) throw new Error("edit mode requires inputPath");
    return [
      "--json", "--json-events", "images", "edit",
      ...common, "--ref-image", job.inputPath, ...fmt, ...sizeQuality, ...comp,
    ];
  }
  return ["--json", "--json-events", "images", "generate", ...common, ...fmt, ...sizeQuality, ...comp];
}

export function parseResult(stdout: string): { ok: boolean; error?: { code: string; message: string } } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { ok: false, error: { code: "parse_error", message: "no JSON on stdout" } };
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1));
    if (obj?.ok === true) return { ok: true };
    return { ok: false, error: obj?.error ?? { code: "unknown", message: "engine reported failure" } };
  } catch {
    return { ok: false, error: { code: "parse_error", message: "stdout not valid JSON" } };
  }
}

export function parseEventLine(line: string): { percent?: number; phase?: string } | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const ev = JSON.parse(t);
    if (ev?.kind === "sse") return null;
    const out: { percent?: number; phase?: string } = {};
    if (typeof ev?.data?.percent === "number") out.percent = ev.data.percent;
    if (typeof ev?.data?.phase === "string") out.phase = ev.data.phase;
    else if (typeof ev?.type === "string") out.phase = ev.type;
    if (out.percent === undefined && out.phase === undefined) return null;
    return out;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
cd paint && git add src/engine.ts test/engine.test.ts
git commit -m "feat(paint): 引擎参数构造与 stdout/stderr 解析

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 事件总线（EventHub）

**Files:**
- Create: `paint/src/events.ts`
- Test: `paint/test/events.test.ts`

**Interfaces:**
- Produces: `type HubListener = (event: string, data: unknown) => void`；`class EventHub`：`subscribe(id: string, fn: HubListener): () => void`（返回取消订阅函数）；`publish(id: string, event: string, data: unknown): void`。

- [ ] **Step 1: 写失败测试**

`paint/test/events.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../src/events.ts";

test("subscribe receives published events", () => {
  const hub = new EventHub();
  const got: any[] = [];
  hub.subscribe("j1", (ev, data) => got.push([ev, data]));
  hub.publish("j1", "progress", { percent: 50 });
  hub.publish("j2", "progress", { percent: 99 }); // other job, ignored
  assert.deepEqual(got, [["progress", { percent: 50 }]]);
});

test("unsubscribe stops delivery", () => {
  const hub = new EventHub();
  const got: any[] = [];
  const off = hub.subscribe("j1", (ev) => got.push(ev));
  off();
  hub.publish("j1", "done", {});
  assert.equal(got.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/events.ts`。

- [ ] **Step 3: 实现 events.ts**

`paint/src/events.ts`：
```ts
export type HubListener = (event: string, data: unknown) => void;

export class EventHub {
  private subs = new Map<string, Set<HubListener>>();

  subscribe(id: string, fn: HubListener): () => void {
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(id);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(id);
    };
  }

  publish(id: string, event: string, data: unknown): void {
    const set = this.subs.get(id);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event, data);
      } catch {
        /* a bad listener must not break others */
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
cd paint && git add src/events.ts test/events.test.ts
git commit -m "feat(paint): 按 job 的内存事件总线（SSE 用）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 回调投递（callback）

**Files:**
- Create: `paint/src/callback.ts`
- Test: `paint/test/callback.test.ts`

**Interfaces:**
- Produces:
  - `function sign(body: string, secret: string): string`（返回 `"sha256=" + hex`）
  - `interface CallbackPayload { job_id: string; status: "done" | "failed"; result_url: string | null; format: string | null; size: string | null; bytes: number | null; error: { code: string; message: string } | null; callback_meta: unknown }`
  - `function deliver(url: string, token: string | undefined, payload: CallbackPayload, secret: string, opts?: { retries?: number; delayMs?: (attempt: number) => number; fetchImpl?: typeof fetch }): Promise<{ ok: boolean; attempts: number }>`

- [ ] **Step 1: 写失败测试**

`paint/test/callback.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sign, deliver, type CallbackPayload } from "../src/callback.ts";

const payload: CallbackPayload = {
  job_id: "j1", status: "done", result_url: "https://x/r.png",
  format: "png", size: "2048x2048", bytes: 10, error: null,
  callback_meta: { note_id: "n1", orig_key: "k1" },
};

test("sign is stable hmac", () => {
  const body = JSON.stringify(payload);
  const expected = "sha256=" + createHmac("sha256", "sec").update(body).digest("hex");
  assert.equal(sign(body, "sec"), expected);
});

test("deliver posts signed body with bearer + meta echoed", async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, status: 200 } as any;
  }) as unknown as typeof fetch;
  const res = await deliver("https://cb", "tok", payload, "sec", { fetchImpl, delayMs: () => 0 });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(seen.url, "https://cb");
  assert.equal(seen.init.headers["Authorization"], "Bearer tok");
  assert.equal(seen.init.headers["X-Paint-Job"], "j1");
  assert.equal(seen.init.headers["X-Paint-Signature"], sign(seen.init.body, "sec"));
  assert.deepEqual(JSON.parse(seen.init.body).callback_meta, { note_id: "n1", orig_key: "k1" });
});

test("deliver retries on 500 then gives up", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return { ok: false, status: 500 } as any; }) as unknown as typeof fetch;
  const res = await deliver("https://cb", undefined, payload, "sec", { fetchImpl, retries: 3, delayMs: () => 0 });
  assert.equal(res.ok, false);
  assert.equal(calls, 3);
});

test("deliver no bearer header when token omitted", async () => {
  let seen: any = null;
  const fetchImpl = (async (_u: string, init: any) => { seen = init; return { ok: true, status: 200 } as any; }) as unknown as typeof fetch;
  await deliver("https://cb", undefined, payload, "sec", { fetchImpl, delayMs: () => 0 });
  assert.equal(seen.headers["Authorization"], undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/callback.ts`。

- [ ] **Step 3: 实现 callback.ts**

`paint/src/callback.ts`：
```ts
import { createHmac } from "node:crypto";

export interface CallbackPayload {
  job_id: string;
  status: "done" | "failed";
  result_url: string | null;
  format: string | null;
  size: string | null;
  bytes: number | null;
  error: { code: string; message: string } | null;
  callback_meta: unknown;
}

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliver(
  url: string,
  token: string | undefined,
  payload: CallbackPayload,
  secret: string,
  opts: { retries?: number; delayMs?: (attempt: number) => number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; attempts: number }> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? ((n) => 1000 * 2 ** (n - 1));
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paint-Job": payload.job_id,
    "X-Paint-Signature": sign(body, secret),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let attempts = 0;
  for (let n = 1; n <= retries; n++) {
    attempts = n;
    try {
      const res = await doFetch(url, { method: "POST", headers, body });
      if (res.ok) return { ok: true, attempts };
    } catch {
      /* network error → retry */
    }
    if (n < retries) await sleep(delayMs(n));
  }
  return { ok: false, attempts };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
cd paint && git add src/callback.ts test/callback.test.ts
git commit -m "feat(paint): webhook 回调投递（HMAC 签名 + 重试）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Worker（并发池 + spawn CLI）

**Files:**
- Create: `paint/src/worker.ts`
- Create: `paint/test/fixtures/fake-gpt-image-2-skill.mjs`
- Test: `paint/test/worker.test.ts`

**Interfaces:**
- Consumes: `Config`、`JobStore`、`EventHub`、`buildArgs/parseResult/parseEventLine`、`deliver`。
- Produces: `class Worker`：`constructor(store: JobStore, hub: EventHub, cfg: Config)`；`enqueue(id: string): void`；内部并发池按 `cfg.maxConcurrency` 串行/并行取 job 跑完整流程（running → spawn → 进度 → done/failed → 回调）。

- [ ] **Step 1: 写打桩 CLI**

`paint/test/fixtures/fake-gpt-image-2-skill.mjs`：
```js
#!/usr/bin/env node
// 打桩版 gpt-image-2-skill：不联网。--out 写个假文件，stderr 吐 JSONL 进度，
// stdout 吐 --json 信封。prompt 含 "FAIL" 则返回错误信封 + 退出码 1。
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const promptIdx = args.indexOf("--prompt");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";

process.stderr.write(JSON.stringify({ data: { percent: 0, phase: "request_started" }, kind: "progress", type: "request_started" }) + "\n");
process.stderr.write(JSON.stringify({ kind: "sse", type: "keepalive", data: {} }) + "\n");
process.stderr.write(JSON.stringify({ data: { percent: 95, phase: "request_completed" }, kind: "progress", type: "request_completed" }) + "\n");

if (prompt.includes("FAIL")) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "http_error", message: "stub failure" } }));
  process.exit(1);
}

if (out) writeFileSync(out, "FAKEPNGDATA");
process.stderr.write(JSON.stringify({ data: { percent: 100, phase: "output_saved" }, kind: "progress", type: "output_saved" }) + "\n");
process.stdout.write(JSON.stringify({ ok: true, output: { path: out, bytes: 11 } }));
process.exit(0);
```

Then: `chmod +x paint/test/fixtures/fake-gpt-image-2-skill.mjs`

- [ ] **Step 2: 写失败测试**

`paint/test/worker.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { loadConfig } from "../src/config.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-worker-"));
  const cfg = loadConfig({ API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  return { cfg, store, hub, worker };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "a cat",
    params: { size: "2K", format: "png", quality: "high", transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(), ...over,
  };
}

async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

test("worker completes a generate job and writes result", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("g1"));
  worker.enqueue("g1");
  await waitFor(async () => (await store.get("g1"))?.status === "done");
  const j = await store.get("g1");
  assert.equal(j?.percent, 100);
  assert.ok(j?.resultPath?.endsWith("g1.png"));
  assert.equal(await readFile(join(cfg.resultsDir, "g1.png"), "utf8"), "FAKEPNGDATA");
});

test("worker marks failed on engine error", async () => {
  const { store, worker } = await setup();
  await store.create(job("f1", { prompt: "please FAIL" }));
  worker.enqueue("f1");
  await waitFor(async () => (await store.get("f1"))?.status === "failed");
  assert.equal((await store.get("f1"))?.error?.code, "http_error");
});

test("worker fires callback on done", async () => {
  const { store, worker, cfg } = await setup();
  // local callback receiver
  const { createServer } = await import("node:http");
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  await store.create(job("c1", { callbackUrl: `http://127.0.0.1:${port}/cb`, callbackToken: "xyz", callbackMeta: { note_id: "n1" } }));
  worker.enqueue("c1");
  await waitFor(async () => received.length > 0);
  srv.close();

  assert.equal(received[0].body.status, "done");
  assert.deepEqual(received[0].body.callback_meta, { note_id: "n1" });
  assert.ok(received[0].body.result_url.endsWith("/results/c1.png"));
  assert.equal(received[0].headers["authorization"], "Bearer xyz");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/worker.ts`。

- [ ] **Step 4: 实现 worker.ts**

`paint/src/worker.ts`：
```ts
import { spawn } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import type { JobStore, Job } from "./store.js";
import type { EventHub } from "./events.js";
import { buildArgs, parseResult, parseEventLine } from "./engine.js";
import { deliver, type CallbackPayload } from "./callback.js";

const EXT: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };

export class Worker {
  private queue: string[] = [];
  private active = 0;

  constructor(private store: JobStore, private hub: EventHub, private cfg: Config) {}

  enqueue(id: string): void {
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.cfg.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active++;
      this.run(id).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job || job.status === "done" || job.status === "failed") return;

    await mkdir(this.cfg.resultsDir, { recursive: true });
    const ext = job.params.transparent ? "png" : (EXT[job.params.format] ?? "png");
    const outPath = join(this.cfg.resultsDir, `${id}.${ext}`);

    let args: string[];
    try {
      args = buildArgs(job, outPath);
    } catch (e: any) {
      await this.fail(job, { code: "invalid_argument", message: e?.message ?? "bad args" });
      return;
    }

    await this.store.update(id, { status: "running", startedAt: new Date().toISOString(), percent: 0 });
    this.hub.publish(id, "progress", { percent: 0, phase: "queued" });

    const env = { ...process.env };
    if (this.cfg.codexHome) env.CODEX_HOME = this.cfg.codexHome;

    const child = spawn(this.cfg.gptImageBin, args, { env });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));

    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => {
      const ev = parseEventLine(line);
      if (!ev) return;
      if (typeof ev.percent === "number") this.store.update(id, { percent: ev.percent }).catch(() => {});
      this.hub.publish(id, "progress", ev);
    });

    const code: number = await new Promise((res) => {
      child.on("close", (c) => res(c ?? 1));
      child.on("error", () => res(1));
    });

    const result = parseResult(stdout);
    let ok = result.ok && code === 0;
    let bytes = 0;
    if (ok) {
      try {
        bytes = (await stat(outPath)).size;
      } catch {
        ok = false;
        result.error = { code: "no_output", message: "engine reported ok but no output file" };
      }
    }

    if (job.inputPath) await unlink(job.inputPath).catch(() => {});

    if (!ok) {
      await this.fail(job, result.error ?? { code: "unknown", message: "generation failed" });
      return;
    }

    const done = await this.store.update(id, {
      status: "done", percent: 100, doneAt: new Date().toISOString(),
      resultPath: outPath, format: ext === "jpg" ? "jpeg" : ext, bytes,
      size: job.params.size,
    });
    const resultUrl = `${this.cfg.publicBaseUrl}/results/${id}.${ext}`;
    this.hub.publish(id, "done", { result_url: resultUrl, bytes, format: done.format, size: done.size });
    await this.maybeCallback(done, "done", resultUrl, null);
  }

  private async fail(job: Job, error: { code: string; message: string }): Promise<void> {
    const failed = await this.store.update(job.id, { status: "failed", error, doneAt: new Date().toISOString() });
    this.hub.publish(job.id, "failed", { error });
    await this.maybeCallback(failed, "failed", null, error);
  }

  private async maybeCallback(
    job: Job,
    status: "done" | "failed",
    resultUrl: string | null,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    if (!job.callbackUrl) return;
    const payload: CallbackPayload = {
      job_id: job.id, status, result_url: resultUrl,
      format: job.format ?? null, size: job.size ?? null, bytes: job.bytes ?? null,
      error, callback_meta: job.callbackMeta ?? null,
    };
    const r = await deliver(job.callbackUrl, job.callbackToken, payload, this.cfg.callbackSigningSecret);
    await this.store.update(job.id, {
      callbackStatus: r.ok ? "delivered" : "failed",
      callbackAttempts: r.attempts,
      lastCallbackAt: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（worker 3 个用例 + 之前全部）。

- [ ] **Step 6: commit**

```bash
cd paint && git add src/worker.ts test/worker.test.ts test/fixtures/fake-gpt-image-2-skill.mjs
git commit -m "feat(paint): Worker 并发池 spawn CLI + 进度/结果/回调

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 清理（cleanup）

**Files:**
- Create: `paint/src/cleanup.ts`
- Test: `paint/test/cleanup.test.ts`（追加到已有测试集）

**Interfaces:**
- Consumes: `Config`、`JobStore`。
- Produces: `function sweep(store: JobStore, cfg: Config, nowMs?: number): Promise<{ deleted: number }>`（删除 createdAt 超 `retentionDays` 的 job 记录 + 其 result/input 文件）。

- [ ] **Step 1: 写失败测试**

`paint/test/cleanup.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import { sweep } from "../src/cleanup.ts";

test("sweep deletes expired jobs and their files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-clean-"));
  const cfg = loadConfig({ API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, RETENTION_DAYS: "30" } as any);
  const store = new JobStore(cfg.jobsDir);
  await mkdir(cfg.resultsDir, { recursive: true });

  const now = Date.parse("2026-07-01T00:00:00Z");
  const oldPath = join(cfg.resultsDir, "old.png");
  await writeFile(oldPath, "x");
  const old: Job = { id: "old", status: "done", mode: "generate", prompt: "p", params: { size: "2K", format: "png", quality: "high", transparent: false }, percent: 100, error: null, createdAt: "2026-05-01T00:00:00Z", resultPath: oldPath };
  const fresh: Job = { ...old, id: "fresh", createdAt: "2026-06-30T00:00:00Z", resultPath: join(cfg.resultsDir, "fresh.png") };
  await writeFile(fresh.resultPath!, "y");
  await store.create(old);
  await store.create(fresh);

  const { deleted } = await sweep(store, cfg, now);
  assert.equal(deleted, 1);
  assert.equal(await store.get("old"), null);
  assert.ok(await store.get("fresh"));
  await assert.rejects(readFile(oldPath));
  assert.equal(await readFile(fresh.resultPath!, "utf8"), "y");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/cleanup.ts`。

- [ ] **Step 3: 实现 cleanup.ts**

`paint/src/cleanup.ts`：
```ts
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { JobStore } from "./store.js";

export async function sweep(store: JobStore, cfg: Config, nowMs: number = Date.now()): Promise<{ deleted: number }> {
  const cutoff = nowMs - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const all = await store.list(Number.MAX_SAFE_INTEGER);
  let deleted = 0;
  for (const j of all) {
    if (Date.parse(j.createdAt) >= cutoff) continue;
    if (j.resultPath) await unlink(j.resultPath).catch(() => {});
    if (j.inputPath) await unlink(j.inputPath).catch(() => {});
    await unlink(join(cfg.jobsDir, `${j.id}.json`)).catch(() => {});
    deleted++;
  }
  return { deleted };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
cd paint && git add src/cleanup.ts test/cleanup.test.ts
git commit -m "feat(paint): 结果保留期清理 sweep

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: HTTP 服务器 + main（路由 / 鉴权 / SSE / 静态）

**Files:**
- Create: `paint/src/server.ts`
- Test: `paint/test/routes.test.ts`

**Interfaces:**
- Consumes: 所有前述模块。
- Produces: `function createApp(cfg: Config, deps: { store: JobStore; hub: EventHub; worker: Worker }): http.Server`（导出便于测试，不自动 listen）；文件底部 `main()` 在直接运行时 `loadConfig` → 建目录 → `recover` 重排队 → 起 cleanup 定时器 → `listen`。
- 路由：
  - `POST /api/jobs`（Bearer）→ 建 job + enqueue → `202 { job_id, poll_url, events_url }`
  - `GET /api/jobs/:id`（Bearer）→ job 状态 JSON
  - `GET /api/jobs?limit=N`（Bearer）→ 列表
  - `GET /api/jobs/:id/events`（Bearer）→ SSE
  - `GET /results/:file` → 静态（防目录穿越）
  - `GET /` → 注入 API_TOKEN 的 index.html

- [ ] **Step 1: 写失败测试**

`paint/test/routes.test.ts`：
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobStore } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { createApp } from "../src/server.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-routes-"));
  const cfg = loadConfig({ API_TOKEN: "secret", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, PUBLIC_BASE_URL: "http://localhost" } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  const app = createApp(cfg, { store, hub, worker });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base };
}

test("POST /api/jobs requires bearer", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  app.close();
});

test("POST /api/jobs 400 when prompt missing", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  app.close();
});

test("full generate flow: submit → poll done → fetch result", async () => {
  const { app, base } = await boot();
  const sub = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "a cat" }) });
  assert.equal(sub.status, 202);
  const { job_id } = await sub.json();
  assert.ok(job_id);

  let status = "";
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/jobs/${job_id}`, { headers: { Authorization: "Bearer secret" } });
    const j = await r.json();
    status = j.status;
    if (status === "done" || status === "failed") {
      if (status === "done") {
        const img = await fetch(`${base}${new URL(j.result_url).pathname}`);
        assert.equal(img.status, 200);
        assert.equal(await img.text(), "FAKEPNGDATA");
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(status, "done");
  app.close();
});

test("results path traversal blocked", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/results/..%2f..%2fetc%2fpasswd`);
  assert.ok(res.status === 400 || res.status === 404);
  app.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL —— `Cannot find module ../src/server.ts`。

- [ ] **Step 3: 实现 server.ts**

`paint/src/server.ts`：
```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（routes 4 个 + 之前全部）。

- [ ] **Step 5: 确认 build 干净**

Run: `cd paint && npm run build`
Expected: 无 TS 错误，生成 `dist/`。

- [ ] **Step 6: commit**

```bash
cd paint && git add src/server.ts test/routes.test.ts
git commit -m "feat(paint): HTTP 服务器（路由/鉴权/SSE/静态/main）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: 网页 UI（public/index.html）

**Files:**
- Create: `paint/public/index.html`

**Interfaces:**
- Consumes: `POST /api/jobs`（JSON，图片走 `image_b64`）、`GET /api/jobs/:id/events`（SSE）、`GET /api/jobs?limit=50`。页面里 `__API_TOKEN__` 占位符由 server 注入。
- 无自动化测试，靠 Step 3 手动冒烟。

- [ ] **Step 1: 写 index.html**

`paint/public/index.html`（浅色，符合用户偏好；单文件无外链）：
```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>paint · gpt-image-2</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif; color: #1a1a1a; background: #f7f7f8; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 18px; font-weight: 600; }
  .card { background: #fff; border: 1px solid #e6e6e9; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  textarea, input, select { width: 100%; padding: 9px 11px; border: 1px solid #d9d9de; border-radius: 8px; font: inherit; background: #fff; }
  textarea { min-height: 74px; resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > label { flex: 1; min-width: 120px; font-size: 13px; color: #555; }
  button { background: #1a1a1a; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .bar { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin: 10px 0; }
  .bar > i { display: block; height: 100%; width: 0; background: #3b82f6; transition: width .3s; }
  .log { font: 12px/1.5 ui-monospace, monospace; color: #666; white-space: pre-wrap; max-height: 120px; overflow: auto; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .gallery a { display: block; border: 1px solid #e6e6e9; border-radius: 8px; overflow: hidden; }
  .gallery img { width: 100%; height: 120px; object-fit: cover; display: block; }
  #result img { max-width: 100%; border-radius: 8px; border: 1px solid #e6e6e9; }
  .muted { color: #888; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>paint · gpt-image-2（Codex 订阅）</h1>
  <div class="card">
    <textarea id="prompt" placeholder="提示词：画什么 / 怎么改这张图"></textarea>
    <div class="row" style="margin:10px 0;">
      <label>参考图（可选，留空=文生图）<input type="file" id="image" accept="image/*" /></label>
    </div>
    <div class="row">
      <label>尺寸<select id="size"><option>2K</option><option>4K</option></select></label>
      <label>格式<select id="format"><option>png</option><option>jpeg</option><option>webp</option></select></label>
      <label>质量<select id="quality"><option>high</option><option>medium</option><option>low</option><option>auto</option></select></label>
      <label>透明底<select id="transparent"><option value="false">否</option><option value="true">是（仅文生图）</option></select></label>
    </div>
    <div style="margin-top:12px;"><button id="go">生成</button></div>
    <div class="bar"><i id="progress"></i></div>
    <div class="log" id="log"></div>
    <div id="result"></div>
  </div>
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center;">
      <strong>历史</strong><span class="muted" id="hcount"></span>
    </div>
    <div class="gallery" id="gallery"></div>
  </div>
</div>
<script>
const TOKEN = "__API_TOKEN__";
const H = { "Authorization": "Bearer " + TOKEN };
const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(s) { logEl.textContent += s + "\n"; logEl.scrollTop = logEl.scrollHeight; }
function fileToB64(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); }); }

async function submit() {
  $("go").disabled = true; logEl.textContent = ""; $("result").innerHTML = ""; $("progress").style.width = "0";
  try {
    const body = {
      prompt: $("prompt").value,
      size: $("size").value, format: $("format").value, quality: $("quality").value,
      transparent: $("transparent").value === "true",
    };
    const f = $("image").files[0];
    if (f) body.image_b64 = await fileToB64(f);
    const r = await fetch("/api/jobs", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { log("错误: " + (j.error || r.status)); $("go").disabled = false; return; }
    log("job " + j.job_id + " 已提交…");
    listen(j.job_id);
  } catch (e) { log("异常: " + e); $("go").disabled = false; }
}

function listen(id) {
  const es = new EventSource("/api/jobs/" + id + "/events?token=" + encodeURIComponent(TOKEN));
  // Note: EventSource can't set headers; server also accepts ?token= for SSE (see Task 8 note).
  es.addEventListener("progress", (e) => { const d = JSON.parse(e.data); if (d.percent != null) $("progress").style.width = d.percent + "%"; if (d.phase) log("· " + d.phase + (d.percent!=null?" "+d.percent+"%":"")); });
  es.addEventListener("done", (e) => { const d = JSON.parse(e.data); $("progress").style.width = "100%"; $("result").innerHTML = '<p class="muted">完成：<a href="'+d.result_url+'" target="_blank">'+d.result_url+'</a></p><img src="'+d.result_url+'">'; es.close(); $("go").disabled = false; loadGallery(); });
  es.addEventListener("failed", (e) => { const d = JSON.parse(e.data); log("失败: " + JSON.stringify(d.error)); es.close(); $("go").disabled = false; });
  es.onerror = () => { es.close(); $("go").disabled = false; };
}

async function loadGallery() {
  const r = await fetch("/api/jobs?limit=50", { headers: H });
  const { jobs } = await r.json();
  const done = jobs.filter((j) => j.status === "done" && j.result_url);
  $("hcount").textContent = done.length + " 张";
  $("gallery").innerHTML = done.map((j) => '<a href="'+j.result_url+'" target="_blank"><img src="'+j.result_url+'" title="'+(j.prompt||"").replace(/"/g,"&quot;")+'"></a>').join("");
}

$("go").addEventListener("click", submit);
loadGallery();
</script>
</body>
</html>
```

- [ ] **Step 2: SSE 支持 ?token=（EventSource 无法带 header）**

浏览器 `EventSource` 不能设置 `Authorization` 头。修改 `src/server.ts` 的 bearer 判定，让 **仅 SSE 路径** 也接受查询参数 `?token=`：

在 `createApp` 里，SSE 分支匹配后、进入 `sseEvents` 前替换鉴权。把 `/api/` 统一鉴权那段改为：SSE 请求（`m[2] === "/events"`）用 `bearerOk(req, cfg.apiToken) || url.searchParams.get("token") === cfg.apiToken`。具体：在 `if (path.startsWith("/api/"))` 顶部，改成先判断是否 events 路径：

```ts
if (path.startsWith("/api/")) {
  const isSse = /^\/api\/jobs\/[^/]+\/events$/.test(path);
  const authed = bearerOk(req, cfg.apiToken) || (isSse && url.searchParams.get("token") === cfg.apiToken);
  if (!authed) return sendJson(res, 401, { error: "unauthorized" });
  ...
```

（其余分支不变。）

- [ ] **Step 3: 手动冒烟（本地，用打桩 CLI）**

```bash
cd paint && npm run build
API_TOKEN=dev CALLBACK_SIGNING_SECRET=dev DATA_DIR=$(mktemp -d) \
  GPT_IMAGE_BIN=$(pwd)/test/fixtures/fake-gpt-image-2-skill.mjs \
  PUBLIC_BASE_URL=http://127.0.0.1:8788 PORT=8788 node dist/server.js &
sleep 1
curl -s http://127.0.0.1:8788/ | grep -c 'paint · gpt-image-2'   # 期望 1（token 已注入，非 __API_TOKEN__）
curl -s http://127.0.0.1:8788/ | grep -c '__API_TOKEN__'          # 期望 0
kill %1
```
Expected: 第一个 grep = 1，第二个 = 0。浏览器打开 `http://127.0.0.1:8788/` 手动点一次「生成」，进度跑到 100%、出现（假）结果、历史出现一张。

- [ ] **Step 4: commit**

```bash
cd paint && git add public/index.html src/server.ts
git commit -m "feat(paint): 浅色网页 UI + SSE ?token= 支持

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: 部署产物（Caddy / systemd / provision / deploy / README）

**Files:**
- Create: `paint/deploy/Caddyfile`, `paint/deploy/paint.service`, `paint/deploy/provision.sh`, `paint/deploy.sh`, `paint/README.md`
- Modify: 根 `/.assetsignore`、`/.pagesignore`（追加 `paint/`，与 `claude-agent` 同处理）

**Interfaces:** 无自动化测试；验证靠 review + 部署后 §Step 6 冒烟。

- [ ] **Step 1: Caddyfile**

`paint/deploy/Caddyfile`：
```
# Caddy: HTTPS(Let's Encrypt) + basic_auth 只护网页；/api 与 /results 交给 Node 自己鉴权。
# 用 provision.sh 生成的 bcrypt hash 替换下方占位。
paint.jianshuo.dev {
	encode gzip

	@webui path /
	basic_auth @webui {
		wjs REPLACE_WITH_BCRYPT_HASH
	}

	reverse_proxy 127.0.0.1:8788 {
		flush_interval -1
	}
}
```

- [ ] **Step 2: systemd unit**

`paint/deploy/paint.service`：
```ini
[Unit]
Description=paint - gpt-image-2 image service (Codex subscription)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paint
Group=paint
WorkingDirectory=/opt/paint
Environment=NODE_ENV=production
Environment=HOME=/opt/paint
EnvironmentFile=/opt/paint/.env
ExecStart=/usr/bin/node /opt/paint/dist/server.js
Restart=always
RestartSec=3

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/paint
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: provision.sh**

`paint/deploy/provision.sh`：
```bash
#!/usr/bin/env bash
# 首次开服 —— 在 VPS 上以 root 运行，幂等。装 Node20+Caddy、建 paint 用户/目录、
# 装 gpt-image-2-skill、装 systemd unit。密钥(.env / Caddyfile hash / auth.json)另放，不进 git。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▸ Node 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "▸ Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
caddy version

echo "▸ gpt-image-2-skill (npm 全局)"
npm i -g gpt-image-2-skill@latest
gpt-image-2-skill --version || true

echo "▸ user + dirs"
id -u paint >/dev/null 2>&1 || useradd --system --home /opt/paint --shell /usr/sbin/nologin paint
mkdir -p /opt/paint/data/jobs /opt/paint/data/results /opt/paint/data/inputs /opt/paint/.codex
chown -R paint:paint /opt/paint

echo "▸ systemd unit"
install -m 644 "$HERE/paint.service" /etc/systemd/system/paint.service
systemctl daemon-reload
systemctl enable paint >/dev/null

cat <<'NEXT'
✓ provisioned. 接下来（都不进 git）:
  1) 放 /opt/paint/.env (chmod 600, owner paint) —— 见 .env.example
  2) 拷 Codex 订阅: scp ~/.codex/auth.json root@vps:/opt/paint/.codex/auth.json
     chown paint:paint /opt/paint/.codex/auth.json && chmod 600 /opt/paint/.codex/auth.json
  3) 验证订阅可用: sudo -u paint CODEX_HOME=/opt/paint/.codex gpt-image-2-skill --json auth inspect
  4) Caddyfile 填 hash: caddy hash-password --plaintext '你的密码' → 写进 /etc/caddy/Caddyfile 的 paint 段 → systemctl reload caddy
  5) systemctl start paint
NEXT
```
Then: `chmod +x paint/deploy/provision.sh`

- [ ] **Step 4: deploy.sh**

`paint/deploy.sh`：
```bash
#!/usr/bin/env bash
# 本地 build → 同步到 VPS → 装 prod 依赖 → 重启。首次开服见 deploy/provision.sh。
set -euo pipefail
VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/paint}"
cd "$(dirname "$0")"
echo "▸ build"; npm run build
echo "▸ test"; npm test
echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude data --exclude .codex --exclude '*.log' \
  dist public package.json package-lock.json deploy \
  "$VPS:$REMOTE/"
echo "▸ install + restart"
ssh "$VPS" "cd $REMOTE && npm ci --omit=dev && chown -R paint:paint $REMOTE/dist $REMOTE/public && systemctl restart paint && sleep 1 && systemctl --no-pager --lines=8 status paint | head -12"
echo "✓ deployed"
```
Then: `chmod +x paint/deploy.sh`

- [ ] **Step 5: README + 根 ignore**

`paint/README.md`：
```markdown
# paint.jianshuo.dev

Codex 订阅版 gpt-image-2 图片服务：网页手动用 + HTTP API（异步 + webhook 回调）给 skill 调。
设计 spec: `docs/superpowers/specs/2026-07-01-paint-jianshuo-dev-image-service-design.md`

## 本地开发
- `npm install && npm test`
- 跑起来（打桩 CLI，不花额度）：见 spec / plan Task 9 Step 3。

## 部署（Tokyo VPS 66.42.45.128）
- 首次：`deploy/provision.sh`（VPS 上 root），然后按提示放 `.env` / `auth.json` / Caddy 密码。
- 更新：本地 `./deploy.sh`。
- 排查：`ssh root@66.42.45.128 'journalctl -u paint -n 50 --no-pager'`

## API
- `POST /api/jobs`（`Authorization: Bearer <API_TOKEN>`）：`{prompt, image_url?|image_b64?, size?, format?, quality?, transparent?, callback_url?, callback_token?, callback_meta?}` → `202 {job_id}`
- `GET /api/jobs/:id` 轮询；`GET /api/jobs/:id/events` SSE。
- 回调：出图后 POST `callback_url`，body `{job_id,status,result_url,callback_meta,...}`，头带 `X-Paint-Signature`(HMAC) 与可选 `Authorization: Bearer <callback_token>`。
```

根 `.assetsignore` 与 `.pagesignore` 各追加一行 `paint/`（确认 `claude-agent/` 已在其中，照抄格式）。

- [ ] **Step 6: commit**

```bash
cd paint && git add deploy deploy.sh README.md
git -C .. add .assetsignore .pagesignore
git commit -m "chore(paint): 部署产物（Caddy/systemd/provision/deploy）+ README + 根 ignore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11（人工）: 上线开服

> 这一步需要真操作 VPS + Codex 订阅，不能全自动化。执行者做完把结果贴回。

- [ ] **Step 1: DNS**：Cloudflare 加 `paint` A 记录 → `66.42.45.128`，**灰云**（DNS only）。
- [ ] **Step 2: provision**：`scp -r paint root@66.42.45.128:/opt/` 后 `ssh root@66.42.45.128 'bash /opt/paint/deploy/provision.sh'`。
- [ ] **Step 3: 密钥**：按 provision 输出放 `/opt/paint/.env`（`openssl rand -hex 32` 生成 `API_TOKEN`/`CALLBACK_SIGNING_SECRET`）、拷 `~/.codex/auth.json`、跑 `auth inspect` 确认 `codex.ready:true`。
- [ ] **Step 4: Caddy**：`caddy hash-password` 生成密码 hash 填进 `/opt/paint/deploy/Caddyfile`（或直接 `/etc/caddy/Caddyfile` 引入），把该 server 段并入 Caddy 主配置，`systemctl reload caddy`。密码记进 iCloud「账户和密码」文档。
- [ ] **Step 5: 启动**：`systemctl start paint` → `journalctl -u paint -n 20`。
- [ ] **Step 6: 真机冒烟**：浏览器开 `https://paint.jianshuo.dev`（过密码）→ 文生图跑一次真 Codex；再传张图跑一次改图。确认出图 + 计费走订阅。
- [ ] **Step 7: 更新记忆**：在 `~/code/jianshuo-memory/08-infrastructure/` 新增 `paint-jianshuo-dev.md`（URL/机器/进程/认证/部署/排查，仿 `lab-jianshuo-dev-agent.md`），并更新根 `CLAUDE.md` 记忆库索引表 08 类 +1。

---

## Self-Review

**1. Spec coverage**（逐条对照 spec）：
- §2 架构（HTTP/存储/worker/回调/引擎）→ Tasks 2/6/5/8/3 ✅
- §3 部署拓扑 + Codex 认证落地 → Task 10 + Task 11（含 CODEX_HOME、auth 写回持久目录、`auth inspect` 验证）✅
- §4 API（POST/GET/SSE/list/results）→ Task 8 ✅（image_url/image_b64 均覆盖；multipart 按设计取消，网页改 base64——见偏差说明）
- §5 回调契约（HMAC + bearer + meta 回传 + 重试 + 幂等头）→ Task 5 + worker.maybeCallback ✅
- §6 job 生命周期 + recover → Task 2（recover）+ Task 8（main 重排队）✅
- §7 网页 → Task 9 ✅
- §8 引擎命令（generate/edit/transparent、stdout/stderr）→ Task 3 + Task 6 ✅
- §9 鉴权（bearer /api、basic_auth 仅网页、results 公开）→ Task 8 + Task 10 Caddyfile ✅
- §10 存储与保留 → Task 7 + main 定时器 ✅
- §11 错误处理 → 提交期校验(Task 8) + 生成失败(Task 6) + auth 失败(冒烟) ✅
- §12 测试 → 各 Task 的单测 + 打桩 CLI + 路由级 e2e ✅

**已知偏差（均在 spec 允许范围内并已说明）：**
- 存储用 JSON-file-per-job 而非 SQLite：spec §1 明确「小 SQLite（或 JSON 文件）」，选 JSON 以保持零运行时依赖、免原生编译，字段与 §6 表一致。
- 上传取消 multipart，网页改 base64（`image_b64`）：仍满足 §4「multipart 或 image_b64」的消费面，且让服务零依赖；API 同时支持 `image_url`（VoiceDrop 用）。

**2. Placeholder scan**：无 TODO/TBD；每个代码步含完整可跑代码。`__API_TOKEN__` 是运行时注入占位符（非计划占位）；`REPLACE_WITH_BCRYPT_HASH`、`.env` 密钥属部署密钥，按约定不进 git，由 Task 11 人工填。

**3. Type consistency**：`Job` 字段跨 store/engine/worker/server 一致；`buildArgs(job,outPath)`、`parseResult(stdout)`、`parseEventLine(line)`、`deliver(url,token,payload,secret,opts)`、`sign(body,secret)`、`EventHub.subscribe/publish`、`JobStore.create/get/update/list/recover`、`Worker.enqueue`、`createApp(cfg,deps)`、`sweep(store,cfg,nowMs)` 在定义处与调用处签名一致 ✅。
