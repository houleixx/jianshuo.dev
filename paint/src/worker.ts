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
