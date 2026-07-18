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
  /** detail 是失败留痕（CLI 返回的原始 detail），只进 job JSON，不进回调 */
  error?: { code: string; message: string; detail?: unknown } | null;
  attempts?: number;
  callbackUrl?: string;
  callbackToken?: string;
  callbackMeta?: unknown;
  /** false = 不把 prompt 写入图片 XMP（默认写）；spec 2026-07-19-paint-xmp-provenance */
  xmpPrompt?: boolean;
  xmpMeta?: Record<string, string>;
  callbackStatus?: "pending" | "delivered" | "failed";
  callbackAttempts?: number;
  lastCallbackAt?: string;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
}

export class JobStore {
  private chains = new Map<string, Promise<unknown>>(); // per-id update serialization (single-process)
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
    const run = async (): Promise<Job> => {
      const cur = await this.get(id);
      if (!cur) throw new Error(`job not found: ${id}`);
      const next = { ...cur, ...patch };
      await this.writeAtomic(next);
      return next;
    };
    const prev = (this.chains.get(id) ?? Promise.resolve()).catch(() => {});
    const p = prev.then(run);
    this.chains.set(id, p.catch(() => {}));
    return p;
  }

  async list(limit: number): Promise<Job[]> {
    await this.ensureDir();
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    const jobs: Job[] = [];
    for (const f of files) {
      try {
        jobs.push(JSON.parse(await readFile(join(this.dir, f), "utf8")));
      } catch {
        /* skip unreadable */
      }
    }
    jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
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
    const tmp = join(this.dir, `.${job.id}.tmp`); // must NOT go through path() (which appends .json)
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, this.path(job.id));
  }
}
