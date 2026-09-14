// src/book-runner.ts — 一单写书/修书的独立进程（2026-09-11）。
//
//   node dist/book-runner.js /opt/claude-agent/inflight/<id>.json
//
// 由 web 进程通过 systemd-run 拉起（见 src/book-launch.ts），一单一进程一单元。
// 从 inflight JSON 读全部参数 → 跑三腿引擎 → 自己做完全部收尾（登记簿、退款、
// 推送、社区帖）→ 销档 → 退出。web 进程从起单那一刻起就不再参与。
//
// 退出码：0 = 这一单已有定论（写成 / 失败均算）；1 = runner 自己崩了（参数读不到、
// 收尾抛异常）。--collect 让两种情况的单元都自动回收。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INFLIGHT_DIR } from "./env.js";
import { removeInflight, writeInflight, type Inflight, type InflightCreate, type InflightRevise } from "./inflight.js";
import { BOOK_LEGS, CODEX_BOOK_PREAMBLE, resumeAfterRestartHint, runBookEngine } from "./book-engine.js";
import {
  findBookByJobId, notifyAdmin, notifyBookDone, patchThreadEntry, readBookMetaRetry, refundBook,
  registerBookPost, writeBookMeta, writeUnmatched, type ThreadEntry,
} from "./bookmeta.js";

async function runCreate(rec: InflightCreate): Promise<void> {
  const { jobId, seed, scope, author, auth, startedAt } = rec;
  const resumed = rec.attempts > 1;
  console.log(`[book] ${resumed ? `resume(第 ${rec.attempts} 次)` : "start"} scope=${scope} author=${author || "-"} job=${jobId} seed=${seed.slice(0, 120).replace(/\n/g, " ")}`);
  const byline = author
    ? `作者署名「${author}」——book.json 的 author 字段用这个名字，封面/页脚照此署名。`
    : `提交者没有留名字——book.json 不写 author 字段，全书不署名（不要默认署任何人名）。`;
  const prompt =
    `${CODEX_BOOK_PREAMBLE}\n\n` +
    `任务：写一本书。${byline}\n` +
    `本次写书任务号 jobId=「${jobId}」——建 book.json 时把它原样写进顶层 "jobId" 字段（登记簿要靠它对号，别漏）。\n` +
    (scope ? `这本书的产权归属 owner=「${scope}」——建 book.json 时把它原样写进顶层 "owner" 字段（谁能在线修改这本书以此为准）。\n` : "") +
    `种子：\n${seed}` +
    (resumed ? resumeAfterRestartHint(jobId) : "");
  let sessionId = "";
  let earlySlug = rec.slug ?? "";
  let finished = false;
  // 边跑边登记：slug 一出现（建筑师落 book.json，约 1 分钟内）就先写 bookmeta
  // （status running）——只在收尾登记的话，进程中途死掉这本书就没有主人
  // （2026-08-20 部署重启掐死在跑任务，实锤丢过一次）。
  // finished 位：clearInterval 挡不住已经在飞的那次回调——引擎返回后回调里的每个
  // await 之后都要再看一眼，否则会把 status:done 又盖回 running、把销掉的档再写回。
  const reg = setInterval(async () => {
    try {
      const hit = await findBookByJobId(jobId);
      if (!hit || finished) return;
      clearInterval(reg);
      const slug: string = hit.book.slug;
      earlySlug = slug;
      // slug 回填进在飞登记：续跑/放弃时省一次反查，也让巡检提示能报书名。
      if (rec.slug !== slug) { rec.slug = slug; if (!finished) await writeInflight(INFLIGHT_DIR, rec).catch(() => {}); }
      // 确定性兜底注入（skill 已要求写，这里保证一定有；只在创建期，修书不受影响；
      // build.mjs 每次发布都从盘上重读 book.json，注入不会被冲掉）：
      //   - 绘本缺省不上架：type=childrens 没写 hidden → 补 "hidden": true；
      //   - 产权：没写 owner → 补 "owner" = 下单人 scope。
      let inject = false;
      if (hit.book?.type === "childrens" && !("hidden" in hit.book)) { hit.book.hidden = true; inject = true; }
      if (scope && !hit.book.owner) { hit.book.owner = scope; inject = true; }
      if (inject) {
        try {
          await writeFile(join(hit.dir, "book.json"), JSON.stringify(hit.book, null, 2) + "\n");
          console.log(`[book] injected defaults slug=${slug} hidden=${hit.book.hidden === true} owner=${hit.book.owner}`);
        } catch (e) {
          console.error("[book] default inject failed", e);
        }
      }
      if (finished) return;
      const meta = (await readBookMetaRetry(slug, [3000])) ?? { slug, scope, author, createdAt: startedAt, thread: [] };
      if (finished) return;
      if (!meta.thread.some((e) => e.ts === startedAt)) {
        meta.thread.push({
          ts: startedAt,
          kind: "create",
          instruction: seed.slice(0, 4000),
          ...(sessionId ? { sessionId } : {}),
          status: "running",
        });
        await writeBookMeta(meta);
        console.log(`[book] early-registered slug=${slug} scope=${scope}`);
      }
    } catch {
      /* 下一轮再试 */
    }
  }, 30000);
  reg.unref?.();

  let ok = false;
  let reply = "";
  try {
    const out = await runBookEngine(prompt, (id) => { sessionId = id; });
    finished = true;
    clearInterval(reg);
    // 引擎一返回就销档：后面的收尾都是幂等的快 HTTP 调用；登记留着反而会在收尾
    // 中途被杀时把一本已退款/已发布的书再跑一遍。
    await removeInflight(INFLIGHT_DIR, rec);
    ok = out.ok;
    reply = out.reply;
    console.log(`[book] done scope=${scope} thread=${out.threadId || "-"}` + (ok ? "" : ` ERROR=${out.error}`));
    if (!ok) {
      await notifyAdmin("写书任务失败", `${seed.slice(0, 40)} · 腿=${BOOK_LEGS.join("→")} · ${String(out.error || "").slice(0, 100)}`);
      await refundBook(auth, { ref: jobId });   // 预扣一口价没写成——原数退回
    }
  } catch (e) {
    finished = true;
    clearInterval(reg);
    await removeInflight(INFLIGHT_DIR, rec);
    console.error("[book] job failed", e);
    // 引擎抛异常（超时/崩溃）同样扣了钱没产出，退款；ref=jobId 幂等，与上面正常
    // 失败分支互斥（try 走完不进 catch），双保险不会双退。
    await refundBook(auth, { ref: jobId });
  }
  // 收尾登记：早登记过就补 status/reply；没有就整条落档。找不到 slug 落
  // _unmatched 便于人工对号——绝不让一本已扣费的书没有主人记录。
  const slug = earlySlug || (await findBookByJobId(jobId))?.book.slug || "";
  const patch: Partial<ThreadEntry> = {
    ...(sessionId ? { sessionId } : {}),
    status: ok ? "done" : "failed",
    ...(reply ? { reply: reply.slice(0, 4000) } : {}),
  };
  if (slug) {
    const meta = await readBookMetaRetry(slug);
    if (meta?.thread.some((e) => e.ts === startedAt)) {
      await patchThreadEntry(slug, startedAt, patch);
    } else {
      const m = meta ?? { slug, scope, author, createdAt: startedAt, thread: [] };
      m.thread.push({ ts: startedAt, kind: "create", instruction: seed.slice(0, 4000), status: "failed", ...patch } as ThreadEntry);
      await writeBookMeta(m);
    }
    console.log(`[book] registered slug=${slug} scope=${scope} session=${sessionId}`);
    // 写成了才推；失败不推用户（钱的事人工处理，别用推送吓人）。
    if (ok) {
      const title = String((await findBookByJobId(jobId))?.book?.title ?? "");
      await registerBookPost(auth, slug);   // 先登记社区帖，推送里的书立刻可在社区看到
      await notifyBookDone(auth, slug, title);
    }
  } else {
    await writeUnmatched(jobId, { scope, author, instruction: seed.slice(0, 4000), ...patch });
    console.error(`[book] job=${jobId} finished but no book.json carries this jobId — wrote _unmatched`);
  }
  // 再销一次档：early-register 回调若恰在引擎返回那一刻正 await writeInflight，
  // 会把刚删掉的文件写回来；收尾这几秒过去后它一定已落地，这里兜底清掉。
  await removeInflight(INFLIGHT_DIR, rec);
}

// 修书：不 resume 写书旧线程（背着整段历史只多花钱）——每次修改都是全新
// 引擎会话，以工作目录/线上成书这些「文件」为真源。
async function runRevise(rec: InflightRevise): Promise<void> {
  const { slug, scope, author, instruction, entryTs, auth } = rec;
  const resumed = rec.attempts > 1;
  console.log(`[revise] ${resumed ? `resume(第 ${rec.attempts} 次)` : "start"} slug=${slug} scope=${scope} instr=${instruction.slice(0, 120).replace(/\n/g, " ")}`);
  const byline = author ? `这本书署名「${author}」，改动不要动署名。` : "这本书不署名，保持不署名。";
  const prompt =
    `${CODEX_BOOK_PREAMBLE}\n\n` +
    `任务：按 skill 的「修书模式」修改一本已出版的书。\n` +
    `slug：${slug}\n${byline}\n` +
    `书的主人提出的修改指令：\n${instruction}\n\n` +
    `要求：只改与指令相关的章节/目录/封面，其余一律不动；改完把受影响的页面重新发布；` +
    `最后一条消息只输出一段给书的主人看的「修改说明」（200 字以内，说清改了什么、动了哪几章），不要别的寒暄。` +
    (resumed ? resumeAfterRestartHint() : "");
  try {
    const out = await runBookEngine(prompt, (id) => {
      patchThreadEntry(slug, entryTs, { sessionId: id }).catch(() => {});
    });
    await removeInflight(INFLIGHT_DIR, rec);   // 引擎返回即销档（理由同写书）
    await patchThreadEntry(slug, entryTs, {
      status: out.ok ? "done" : "failed",
      ...(out.reply ? { reply: out.reply.trim().slice(0, 4000) } : {}),
      ...(out.ok ? {} : { error: out.error }),
    });
    console.log(`[revise] done slug=${slug} thread=${out.threadId || "-"}` + (out.ok ? "" : ` ERROR=${out.error}`));
    if (out.ok) await registerBookPost(auth, slug);   // 标题/hidden/章节数可能变了——刷新书帖
    if (!out.ok) {
      await notifyAdmin("修书任务失败", `${slug} · 腿=${BOOK_LEGS.join("→")} · ${String(out.error || "").slice(0, 100)}`);
      await refundBook(auth, { ref: `${slug}#${entryTs}`, kind: "revise" });   // 修书没改成——退回预扣的 40
    }
  } catch (e: any) {
    await removeInflight(INFLIGHT_DIR, rec);
    console.error("[revise] job failed", e);
    await patchThreadEntry(slug, entryTs, { status: "failed", error: String(e?.message ?? e) }).catch(() => {});
    await refundBook(auth, { ref: `${slug}#${entryTs}`, kind: "revise" });   // 引擎崩溃同样退
  }
}

async function main() {
  const p = process.argv[2];
  if (!p) throw new Error("usage: book-runner <inflight.json>");
  const rec = JSON.parse(await readFile(p, "utf8")) as Inflight;
  if (rec.kind === "create") await runCreate(rec);
  else if (rec.kind === "revise") await runRevise(rec);
  else throw new Error(`unknown inflight kind in ${p}`);
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
main().then(
  () => process.exit(0),
  (e) => {
    console.error("[book-runner] fatal", e);
    process.exit(1);
  },
);
