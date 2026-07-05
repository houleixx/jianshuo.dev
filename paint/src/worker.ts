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

// OpenAI 输出端内容过滤会概率性扣下已生成的图（响应正常结束但没有图片项，
// 同一 prompt 重跑大概率就过）——这类错误自动重试一次。
const RETRYABLE = new Set(["missing_image_result"]);
const MAX_ATTEMPTS = 2;

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
      this.run(id)
        .catch((e) => console.error(`[worker] job ${id} crashed`, e))
        .finally(() => {
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
      if (job.inputPath) await unlink(job.inputPath).catch(() => {});
      await this.fail(job, { code: "invalid_argument", message: e?.message ?? "bad args" }, 0);
      return;
    }

    await this.store.update(id, { status: "running", startedAt: new Date().toISOString(), percent: 0 });
    this.hub.publish(id, "progress", { percent: 0, phase: "queued" });

    let attempts = 0;
    let ok = false;
    let bytes = 0;
    let error: { code: string; message: string; detail?: unknown } | undefined;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      ({ ok, bytes, error } = await this.attempt(id, args, outPath));
      if (ok || !RETRYABLE.has(error?.code ?? "")) break;
      if (attempts < MAX_ATTEMPTS) {
        await this.store.update(id, { percent: 0 });
        this.hub.publish(id, "progress", { percent: 0, phase: "retrying" });
      }
    }

    // 输入文件要等重试全部结束再清（edit 的第二次尝试还要用它）
    if (job.inputPath) await unlink(job.inputPath).catch(() => {});

    if (!ok) {
      await this.fail(job, error ?? { code: "unknown", message: "generation failed" }, attempts);
      return;
    }

    const done = await this.store.update(id, {
      status: "done", percent: 100, doneAt: new Date().toISOString(), attempts,
      resultPath: outPath, format: ext === "jpg" ? "jpeg" : ext, bytes,
      size: job.params.size,
    });
    const resultUrl = `${this.cfg.publicBaseUrl}/results/${id}.${ext}`;
    this.hub.publish(id, "done", { result_url: resultUrl, bytes, format: done.format, size: done.size });
    await this.maybeCallback(done, "done", resultUrl, null);
  }

  /** 跑一次 CLI：spawn → 进度转发 → 解析结果 → 校验产物文件 */
  private async attempt(
    id: string,
    args: string[],
    outPath: string,
  ): Promise<{ ok: boolean; bytes: number; error?: { code: string; message: string; detail?: unknown } }> {
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
    return { ok, bytes, error: result.error };
  }

  private async fail(job: Job, error: { code: string; message: string; detail?: unknown }, attempts: number): Promise<void> {
    // detail 留在 job JSON 里做诊断留痕；对外（事件/回调）只给 code/message
    const failed = await this.store.update(job.id, { status: "failed", error, attempts, doneAt: new Date().toISOString() });
    const publicError = { code: error.code, message: error.message };
    this.hub.publish(job.id, "failed", { error: publicError });
    await this.maybeCallback(failed, "failed", null, publicError);
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
