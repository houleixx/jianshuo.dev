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
