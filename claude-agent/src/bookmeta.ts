// src/bookmeta.ts — 书的登记簿 + 与 jianshuo.dev worker 的往来（扣费/退款/推送/书帖）。
// web 进程（收单、history）与 book-runner 进程（收尾）共用；2026-09-11 从 server.ts 搬出。
//
// --- 书的登记簿：产权在 book.json（owner 字段），对话线在 R2 _src/bookmeta.json ---
//
// 2026-08-23 起 bookmeta 不再以 VPS 本地文件为真源（VPS 重装会丢）：
//   - 产权：book.json 顶层 "owner"（= 创建时扣费账户的 scope，公开信息，与 photo
//     URL 同级）。写书时建筑师直接写 + 30s 轮询确定性兜底注入，build.mjs 随发布
//     镜像到 R2 _src/book.json —— R2 即真源，天然持久。
//   - 对话线：R2 books/<slug>/_src/bookmeta.json = { slug, scope, author,
//     createdAt, thread: [entry…] }，entry = { ts, kind: "create"|"revise",
//     instruction, sessionId?, status: "running"|"done"|"failed", reply?, error? }。
//     由 lab 独占读写（与 codex 并发改 book.json 互不打架），走 files API 上传
//     （发布账号 token），读走公开 URL 带时间戳穿透 5 分钟边缘缓存。
//   - 本地 bookmeta/ 目录只剩两个用途：老条目的读回退（读到即懒迁移上 R2）和
//     _unmatched 落档。sessionId：codex 线程号（CODEX_HOME/sessions/ 可续）。
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOOKMETA_DIR, HOME, WORKSPACE } from "./env.js";
import { BOOK_RUN_DIR } from "./book-engine.js";

const BOOK_CHARGE_URL = process.env.BOOK_CHARGE_URL ?? "https://jianshuo.dev/agent/usage/book-charge";
const BOOK_REFUND_URL = process.env.BOOK_REFUND_URL ?? "https://jianshuo.dev/agent/usage/book-refund";
const BOOK_PUSH_URL = process.env.BOOK_PUSH_URL ?? "https://jianshuo.dev/agent/push/book-done";
const ADMIN_PUSH_URL = process.env.ADMIN_PUSH_URL ?? "https://jianshuo.dev/agent/push/admin";
const BOOK_COMMUNITY_URL = process.env.BOOK_COMMUNITY_URL ?? "https://jianshuo.dev/agent/book/community";
const FILES_API = "https://jianshuo.dev/files/api";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ThreadEntry = {
  ts: number;
  kind: "create" | "revise";
  instruction: string;
  sessionId?: string;
  status: "running" | "done" | "failed";
  reply?: string;
  error?: string;
};
// author 只是创建期的引导值，不是真源：书还没发布时线上还没有 _src/book.json，
// 只能先用它顶着。发布之后一律以 book.json 的 author 为准（见 bookAuthor）。
export type BookMeta = { slug: string; scope: string; author?: string; createdAt: number; thread: ThreadEntry[] };

function metaPath(slug: string): string {
  return join(BOOKMETA_DIR, slug + ".json");
}

// 发布账号凭据（与 build.mjs 同源 ~/.config/voicedrop/credentials）：token 上传对话线/
// 推管理员用，scope 做存储层所有权兜底。读一次缓存住。
let cachedCreds: { token: string; scope: string } | null = null;
async function publisherCreds(): Promise<{ token: string; scope: string }> {
  if (cachedCreds) return cachedCreds;
  try {
    const j = JSON.parse(await readFile(join(HOME, ".config", "voicedrop", "credentials"), "utf8"));
    cachedCreds = { token: String(j?.token ?? ""), scope: String(j?.scope ?? "") };
    return cachedCreds;
  } catch {
    return { token: "", scope: "" }; // 下次再试
  }
}
export async function publisherToken(): Promise<string> {
  return (await publisherCreds()).token;
}
export async function publisherScope(): Promise<string> {
  return (await publisherCreds()).scope;
}

// 「R2 上没有」与「这次没读到」必须分开（2026-09-12）：以前两者都返回 null，修书路径
// 拿到 null 就新建一条空 thread 覆盖回 R2——一次 502 就把整本书的对话线抹掉；收尾的
// patchThreadEntry 读到 null 则静默放弃，条目永远 running、这本书永远 409 busy。
// 现在：404 → null（真没有）；网络抖动/5xx/坏 JSON → 抛错，调用方自己决定重试或放弃本次写。
export async function readBookMeta(slug: string): Promise<BookMeta | null> {
  let missing = false;
  let failure = "";
  // R2 为真源；?_= 穿透书页路由的 5 分钟边缘缓存（App 轮询 history 要看到实时进度）。
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/_src/bookmeta.json?_=${Date.now()}`);
    if (r.ok) return await r.json();
    if (r.status === 404) missing = true;
    else failure = `http ${r.status}`;
  } catch (e: any) {
    failure = String(e?.message ?? e);
  }
  // 本地老条目：R2 确认没有时读到即懒迁移；R2 没读到时本地那份（上次上传失败的回落件）
  // 反而是最新的，直接用。
  try {
    const legacy = JSON.parse(await readFile(metaPath(slug), "utf8"));
    if (missing) writeBookMeta(legacy).catch(() => {});
    return legacy;
  } catch {
    /* 没有本地件 */
  }
  if (missing) return null;
  throw new Error(`bookmeta unreachable slug=${slug}: ${failure}`);
}

/** 读登记簿，读不到就退避重试（runner 收尾用：宁可多等一分钟也别丢条目）。 */
export async function readBookMetaRetry(slug: string, delaysMs: number[] = [2000, 5000, 15000, 30000]): Promise<BookMeta | null> {
  for (let i = 0; ; i++) {
    try {
      return await readBookMeta(slug);
    } catch (e) {
      if (i >= delaysMs.length) throw e;
      console.error(`[bookmeta] read failed slug=${slug}, retry in ${delaysMs[i]}ms:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}

// 进程内低频写，串行化一下防「读-改-写」互相覆盖。跨进程（web 收单 vs runner 收尾）
// 没有这层保护——但登记簿按 slug 分文件，同一本书同时只有一单在跑（409 busy），
// 收单与收尾不会碰同一份。上传失败回落本地文件——宁可暂留 VPS 也绝不丢条目
// （下次 readBookMeta 会再懒迁移）。
let metaWriteChain: Promise<unknown> = Promise.resolve();
export function writeBookMeta(meta: BookMeta): Promise<void> {
  const p = metaWriteChain.then(async () => {
    const body = JSON.stringify(meta, null, 2) + "\n";
    try {
      const tok = await publisherToken();
      if (!tok) throw new Error("no publisher token");
      const r = await fetch(`${FILES_API}/upload/books/${meta.slug}/_src/bookmeta.json`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body,
      });
      if (!r.ok) throw new Error(`upload ${r.status}`);
      await unlink(metaPath(meta.slug)).catch(() => {}); // R2 落定后清掉本地旧件，防回退读到陈旧线
    } catch (e) {
      console.error(`[bookmeta] R2 upload failed slug=${meta.slug}:`, e instanceof Error ? e.message : e);
      await mkdir(BOOKMETA_DIR, { recursive: true });
      await writeFile(metaPath(meta.slug), body);
    }
  });
  metaWriteChain = p.catch(() => {});
  return p as Promise<void>;
}
// 改一条状态：读失败会重试（读不到就放弃等于丢掉 status:done，这本书之后永远 busy）。
export async function patchThreadEntry(slug: string, ts: number, patch: Partial<ThreadEntry>): Promise<void> {
  const meta = await readBookMetaRetry(slug);
  if (!meta) return;
  const e = meta.thread.find((x) => x.ts === ts);
  if (!e) return;
  Object.assign(e, patch);
  await writeBookMeta(meta);
}

/** 找不到 slug 时的落档（绝不让一本已扣费的书没有主人记录）。 */
export async function writeUnmatched(jobId: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(BOOKMETA_DIR, { recursive: true });
  await writeFile(join(BOOKMETA_DIR, `_unmatched-${jobId}.json`), JSON.stringify({ jobId, ...record }, null, 2) + "\n");
}

// 写书 job 起跑时还不知道 slug（slug 是建筑师中途起的），所以把任务号 jobId 塞进
// prompt 让 agent 写进 book.json；收尾时拿 jobId 去工作目录里反查 slug。
// 扫三处：WORKSPACE（修书/新版写书的耐久工作目录）、BOOK_RUN_DIR、/tmp（旧约定）。
export async function findBookByJobId(jobId: string): Promise<{ dir: string; book: any } | null> {
  for (const root of [WORKSPACE, BOOK_RUN_DIR, "/tmp"]) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        const j = JSON.parse(await readFile(join(root, d, "book.json"), "utf8"));
        if (j?.jobId === jobId && typeof j?.slug === "string" && SLUG_RE.test(j.slug))
          return { dir: join(root, d), book: j };
      } catch {
        /* not a book dir */
      }
    }
  }
  return null;
}

// 认证 = 计费（2026-08-10 起，替代早前的「须有成文文章 + 每日限额」门槛）：
// 转发用户 bearer 到 agent worker 的 book-charge，一口价扣 160 算力（真源在
// agent/src/usage.js 的 BOOK_SUANLI），扣成功才开写。数量限制全部取消——算力就是
// 闸门。注意 2026-09-01 降价到 160 后，注册赠送 200 已经够写第一本，「新账户不够
// 一本」这个旧的天然门槛没有了。dry=true 只验余额不扣（部署冒烟 + App 预检）。
export async function chargeBook(
  auth: string | undefined,
  extra: { seed?: string; slug?: string; kind?: "revise" },
  dry: boolean,
): Promise<{ status: number; body: any }> {
  if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "bad token" } };
  try {
    const r = await fetch(BOOK_CHARGE_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ...extra, seed: extra.seed?.slice(0, 200), dry }),
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  } catch {
    return { status: 502, body: { error: "charge unreachable" } };
  }
}

// 写书/修书失败退款（2026-08-27）：预扣一口价的书没写成——引擎被拒/超时/崩溃——
// 用下单时那枚用户 bearer 调 worker 的 book-refund，把预扣的算力原数还回。ref 幂等
// （写书=jobId、修书=slug#ts），worker 端同 ref 只退一次。尽力而为：退不成只留日志，
// 绝不抛错（退款失败还有管理员报警兜底人工补）。
export async function refundBook(auth: string | undefined, extra: { ref: string; kind?: "revise" }): Promise<void> {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_REFUND_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(extra),
    });
    const body: any = await r.json().catch(() => ({}));
    console.log(`[book] refund ref=${extra.ref} kind=${extra.kind ?? "book"} status=${r.status} ${body?.deduped ? "deduped" : `refunded=${body?.refunded_suanli ?? "?"}`}`);
  } catch (e) {
    console.error("[book] refund failed", e);
  }
}

// 系统级故障/任务失败 → 立刻推管理员（2026-08-24 用户要求）。用发布账号 token
// 认自己人（worker 端校验 scope==ADMIN_SCOPE），无需新密钥。尽力而为不抛错。
export async function notifyAdmin(title: string, body: string) {
  try {
    const tok = await publisherToken();
    if (!tok) return;
    const r = await fetch(ADMIN_PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    console.log(`[admin-push] ${title} status=${r.status}`);
  } catch (e) {
    console.error("[admin-push] failed", e);
  }
}

// 书写好了给主人发 APNs（2026-08-23）：worker /agent/push/book-done 用同一枚用户
// bearer 认人——lab 不存推送凭据，token 是谁的就推给谁。尽力而为，失败只留日志。
export async function notifyBookDone(auth: string | undefined, slug: string, title: string) {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_PUSH_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug, title }),
    });
    console.log(`[book] push slug=${slug} status=${r.status}`);
  } catch (e) {
    console.error("[book] push failed", e);
  }
}

// 书帖登记（2026-08-27）：写书/修书收尾把书 upsert 成社区一等帖（agent worker
// /agent/book/community，share_id "book-<slug>"）——赞/回应/推荐排序与普通帖同权，
// 取代 reco 的读时混入。同一枚用户 bearer 认人（主人的 hidden 书也带得出来，
// hidden 照登记、feed 自然不出）。尽力而为：失败只留日志，漂了用 admin 批量回填。
export async function registerBookPost(auth: string | undefined, slug: string) {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_COMMUNITY_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    console.log(`[book] community-post slug=${slug} status=${r.status}`);
  } catch (e) {
    console.error("[book] community-post failed", e);
  }
}

// 用 bearer 问 files API 这是谁（history 只读不扣费，用这个拿 scope 做主人校验）。
export async function fetchScope(auth: string | undefined): Promise<string> {
  if (!auth?.startsWith("Bearer ")) return "";
  try {
    const r = await fetch(`${FILES_API}/whoami`, { headers: { Authorization: auth } });
    if (!r.ok) return "";
    return String(((await r.json()) as any)?.scope ?? "");
  } catch {
    return "";
  }
}

// 线上 _src 源稿镜像的 book.json（取署名/产权用；老书没有 _src，返回 null 不算书不存在）。
// ?_= 穿透书页路由的 5 分钟边缘缓存：修书刚改完署名、新书刚发布，主人校验和署名都要
// 立刻看到新值，不能等缓存过期（与 readBookMeta 同一考虑）。
export async function fetchSrcBook(slug: string): Promise<any | null> {
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/_src/book.json?_=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// 署名真源 = book.json 的 author（修书会改它）。登记簿里那份是创建期快照，之后再没
// 更新过——反过来优先读它就会漂：改了署名，登记簿不跟着变，修书 prompt 还会拿旧名字
// 去叮嘱 agent「不要动署名」，把已经改对的名字又写回去。老书没有 _src 才回退到它。
export function bookAuthor(srcBook: any | null, meta: BookMeta | null): string {
  return String(srcBook?.author ?? "") || String(meta?.author ?? "");
}

// 书存在与否以公开目录页为准——_src 是 2026-08-15 才有的，老书只有 index.html。
export async function bookExistsOnline(slug: string): Promise<boolean> {
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/index.html`, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

// 真实作者署名（2026-08-11）：用提交者自己的 bearer 拉他的 CLAUDE.json，取
// profile.name（设置页「名字」，挖文章署名同源）。拉不到/没填 → 空，书就不署名
// ——绝不回落到任何默认人名。
export async function fetchAuthorName(auth: string | undefined): Promise<string> {
  if (!auth) return "";
  try {
    const r = await fetch(`${FILES_API}/download/CLAUDE.json`, { headers: { Authorization: auth } });
    if (!r.ok) return "";
    const j: any = await r.json();
    return String(j?.profile?.name || "").trim().slice(0, 20);
  } catch {
    return "";
  }
}
