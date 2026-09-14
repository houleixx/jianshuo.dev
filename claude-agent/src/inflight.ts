// src/inflight.ts — 写书/修书的「在飞」登记（2026-09-08）。
//
// 背景：书是在本进程里后台跑的，systemctl restart 一下（发版/崩溃）子进程就死，
// 而登记簿里那条永远停在 running——不发布、不退款、不告警、不推送，从外面看就是
// 「写到一半没后文了」。9/8 上午《嘟嘟和山上的灯塔》14 页全写完、14 张图全画完，
// 差一步发布，被一次发版 restart 杀在终点线上，就是这样。
//
// 办法：每单开工时在 inflight/ 落一个 JSON（任务的全部再现参数：种子/主人/署名/
// 下单 bearer/起跑时间），引擎跑完立刻删。于是**启动时目录里还有文件 = 上次没跑完
// 的孤儿**，服务一起来就按文件把它续上（prompt 追「先查半成品别另起」）；同一单续
// 过 INFLIGHT_MAX_ATTEMPTS 次还没完就认输：标 failed + 退款 + 告警。deploy.sh 也看
// 这个目录：非空就不 restart。
//
// bearer 落盘的取舍：退款/推送/书帖登记都要用下单那枚用户 bearer 认人，不存就续
// 不完整。文件 0600、放在 ReadWritePaths=/opt/claude-agent 沙箱内、与 .env 里的
// OAuth token 和 .codex/auth.json 同一信任边界，跑完即删——可接受。
//
// 纯文件操作、不 import server.ts（import 即起服务），可单测。
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type InflightCreate = {
  kind: "create";
  jobId: string;
  seed: string;
  scope: string;
  author: string;
  auth?: string;
  startedAt: number;     // = 登记簿 thread 条目的 ts，续跑时靠它对上同一条
  slug?: string;         // early-register 拿到后回填，续跑/放弃时省一次反查
  attempts: number;      // 引擎已被拉起的次数（0 = 还在排队没起过；原跑算第 1 次）
  launchedAt?: number;   // 最近一次起单元的时刻（排队中的没有）
};
export type InflightRevise = {
  kind: "revise";
  slug: string;
  scope: string;
  author: string;
  instruction: string;
  entryTs: number;       // 登记簿 thread 条目的 ts
  auth?: string;
  startedAt: number;
  attempts: number;
  launchedAt?: number;
};
export type Inflight = InflightCreate | InflightRevise;

/** 原跑 + 续跑各算一次；第 3 次不再试——两次都没跑完，多半不是「被打断」而是书本身有问题。 */
export const INFLIGHT_MAX_ATTEMPTS = 2;

/** 还在排队、一次都没起过（2026-09-12 起收单先落档，由 pump 按并发上限起单）。 */
export function isQueued(rec: Inflight): boolean {
  return rec.attempts === 0;
}

/** 登记的稳定标识：写书=jobId，修书=slug#entryTs（与退款 ref 同一套，幂等对得上）。 */
export function inflightId(rec: Inflight): string {
  return rec.kind === "create" ? rec.jobId : `${rec.slug}#${rec.entryTs}`;
}

/** 文件名里 # 不好看也不好 shell，换成 __。 */
export function inflightPath(dir: string, rec: Inflight): string {
  return join(dir, inflightId(rec).replace(/#/g, "__") + ".json");
}

export function canRetry(rec: Inflight): boolean {
  return rec.attempts < INFLIGHT_MAX_ATTEMPTS;
}

/** 落盘（临时文件 + rename，读到的永远是完整 JSON；0600 因为里面有 bearer）。 */
export async function writeInflight(dir: string, rec: Inflight): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const p = inflightPath(dir, rec);
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, p);
}

export async function removeInflight(dir: string, rec: Inflight): Promise<void> {
  await unlink(inflightPath(dir, rec)).catch(() => {});
}

/** 列出全部登记（坏文件跳过不抛：一个坏文件不该拖住别的孤儿）。按起跑时间升序，先来先续。 */
export async function listInflight(dir: string): Promise<Inflight[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Inflight[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const j = JSON.parse(await readFile(join(dir, n), "utf8"));
      if (isInflight(j)) out.push(j);
    } catch {
      /* 半截文件/手写坏了：跳过 */
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function isInflight(j: any): j is Inflight {
  if (!j || typeof j !== "object" || typeof j.attempts !== "number" || typeof j.startedAt !== "number") return false;
  if (j.kind === "create") return typeof j.jobId === "string" && typeof j.seed === "string";
  if (j.kind === "revise") return typeof j.slug === "string" && typeof j.entryTs === "number";
  return false;
}
