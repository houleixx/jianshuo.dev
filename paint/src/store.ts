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
