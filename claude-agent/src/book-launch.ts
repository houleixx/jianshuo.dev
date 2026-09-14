// src/book-launch.ts — 把一单写书/修书交给 systemd 跑（2026-09-11）。
//
// 背景：书以前在 web 进程里 spawn，systemctl restart 一下（发版/崩溃/OOM）书就死，
// 于是长出 inflight 登记、deploy.sh 重启守卫、启动续跑、attempts 封顶一整套补偿。
// 病根是「几小时的作业挂在 HTTP 进程名下」。现在每单交给 claude-agent 用户自己的
// systemd 用户管理器（loginctl enable-linger）跑成瞬态单元：
//
//   systemd-run --user --unit=book-<jobId> … node dist/book-runner.js inflight/<id>.json
//
// 单元挂在 user@997.service 底下，与 claude-agent.service 不同 cgroup——web 进程随便
// 重启、崩溃，书照写。VPS 侧的前提（provision.sh / claude-agent.service 已配）：
//   · loginctl enable-linger claude-agent（用户管理器开机常驻）；
//   · web 服务能连到用户 bus：ProtectHome=read-only + ReadWritePaths=/run/user/<uid>
//     （ProtectHome=yes 会把 /run/user 整个藏掉，systemd-run 报 Operation not permitted，
//     2026-09-11 二分实测）；XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS 指向它。
//
// 没有 systemd 的机器（本地 Mac 开发）退回 detached 直起 node——子进程脱离父进程，
// 语义上最接近，只是少了单元名/日志/取消这些便利。
//
// 纯函数（unitName / buildSystemdRunArgs）不碰进程，可单测。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { APP_ROOT, INFLIGHT_DIR } from "./env.js";
import { canRetry, inflightId, inflightPath, isQueued, type Inflight } from "./inflight.js";

const NODE_BIN = process.execPath;
const RUNNER = join(APP_ROOT, "dist", "book-runner.js");
const SYSTEMD_RUN = process.env.SYSTEMD_RUN_BIN ?? "systemd-run";
const SYSTEMCTL = process.env.SYSTEMCTL_BIN ?? "systemctl";
// 与 .env 同一份：runner 要读到 BOOK_* / CLAUDE_CODE_OAUTH_TOKEN 等全部凭据。
const ENV_FILE = process.env.BOOK_UNIT_ENV_FILE ?? join(APP_ROOT, ".env");

/** 单元名：写书 book-<jobId>，修书 revise-<slug>-<ts>。systemd 单元名不许有 #。 */
export function unitName(rec: Inflight): string {
  return rec.kind === "create" ? `book-${rec.jobId}` : `revise-${rec.slug}-${rec.entryTs}`;
}

/** 完整 argv（不含 systemd-run 本身）。 */
export function buildSystemdRunArgs(
  rec: Inflight,
  o: { runner?: string; node?: string; envFile?: string; appRoot?: string; inflightDir?: string; home?: string } = {},
): string[] {
  const appRoot = o.appRoot ?? APP_ROOT;
  return [
    "--user",
    `--unit=${unitName(rec)}`,
    "--collect",                       // 跑完（含失败）自动回收，别在 list-units 里堆尸体
    "--quiet",
    `--description=voicedrop ${rec.kind === "create" ? "写书" : "修书"} ${inflightId(rec)}`,
    `--property=WorkingDirectory=${appRoot}`,
    `--property=EnvironmentFile=${o.envFile ?? ENV_FILE}`,
    "--property=TimeoutStopSec=30",     // stop 时先 SIGTERM，30s 不退再 SIGKILL
    `--setenv=HOME=${o.home ?? appRoot}`,
    "--setenv=NODE_ENV=production",
    o.node ?? NODE_BIN,
    o.runner ?? RUNNER,
    inflightPath(o.inflightDir ?? INFLIGHT_DIR, rec),
  ];
}

// web 服务里没有登录会话，systemd-run 靠这两个变量找到用户 bus；服务单元里设了，
// 这里再按 uid 兜底一遍，免得哪天单元文件漏了就静默退回 detached 直起。
function busEnv(): Record<string, string> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const rt = process.env.XDG_RUNTIME_DIR ?? (uid >= 0 ? `/run/user/${uid}` : "");
  return {
    ...(rt ? { XDG_RUNTIME_DIR: rt } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS
      ? {}
      : rt ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${rt}/bus` } : {}),
  };
}

export type LaunchResult = { ok: boolean; unit: string; via: "systemd" | "detached" | ""; error: string };

/**
 * 起单。inflight 文件必须已经落盘（runner 从文件读全部参数）。
 * systemd-run 退出码 0 = 单元已在 systemd 名下，此后与本进程无关。
 */
export function launchBookUnit(rec: Inflight): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const unit = unitName(rec);
    const child = spawn(SYSTEMD_RUN, buildSystemdRunArgs(rec), {
      env: { ...process.env, ...busEnv() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-1000)));
    child.on("error", (e: any) => {
      if (e?.code === "ENOENT") resolve(launchDetached(rec)); // 没有 systemd：本地开发
      else resolve({ ok: false, unit, via: "", error: `systemd-run: ${e?.message ?? e}` });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, unit, via: "systemd", error: "" });
      else resolve({ ok: false, unit, via: "", error: `systemd-run exit ${code}: ${stderr.trim() || "(no stderr)"}` });
    });
  });
}

function launchDetached(rec: Inflight): LaunchResult {
  try {
    const child = spawn(NODE_BIN, [RUNNER, inflightPath(INFLIGHT_DIR, rec)], {
      cwd: APP_ROOT,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, unit: unitName(rec), via: "detached", error: "" };
  } catch (e: any) {
    return { ok: false, unit: unitName(rec), via: "", error: `detached spawn: ${e?.message ?? e}` };
  }
}

/** 该单的单元是否还在跑（启动巡检用：活着的不是孤儿）。没有 systemd 一律 false。 */
export function isUnitActive(rec: Inflight): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(SYSTEMCTL, ["--user", "is-active", "--quiet", unitName(rec)], {
      env: { ...process.env, ...busEnv() },
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** 当前在跑的写书/修书单元名集合（不含 .service 后缀）。没有 systemd 返回空集。 */
export function listActiveUnits(): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = spawn(SYSTEMCTL, ["--user", "list-units", "--plain", "--no-legend", "book-*", "revise-*"], {
      env: { ...process.env, ...busEnv() },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("error", () => resolve(new Set()));
    child.on("close", () => {
      const set = new Set<string>();
      for (const ln of out.split("\n")) {
        const [name, , active] = ln.trim().split(/\s+/);
        if (name?.endsWith(".service") && active === "active") set.add(name.slice(0, -".service".length));
      }
      resolve(set);
    });
  });
}

export type LaunchPlan = { launch: Inflight[]; giveUp: Inflight[]; queued: Inflight[]; running: Inflight[] };

/**
 * 并发闸门（2026-09-12）：写书曾没有任何上限——9/2 两位用户各点三本，7 个引擎同时起，
 * 三条腿的配额几分钟内轮流打穿、每本烧几十轮才倒。三腿链只是在给「同时打 7 单」擦屁股。
 * 现在收单先落档（attempts=0 排队），这里按「在跑的单元数 < 上限」决定起谁：
 *   · 单元还活着 → running，不碰；
 *   · 起过但单元没了（VPS 重启/runner 崩）→ 次数没到上限就当续跑候选，到了就 giveUp；
 *   · 排队的 → 候选。候选按起跑时间先来先起，直到把空位填满。
 * 纯函数，可单测。
 */
export function planLaunches(recs: Inflight[], active: Set<string>, max: number): LaunchPlan {
  const plan: LaunchPlan = { launch: [], giveUp: [], queued: [], running: [] };
  let slots = Math.max(0, max - active.size);
  for (const rec of [...recs].sort((a, b) => a.startedAt - b.startedAt)) {
    if (active.has(unitName(rec))) { plan.running.push(rec); continue; }
    if (!isQueued(rec) && !canRetry(rec)) { plan.giveUp.push(rec); continue; }
    if (slots > 0) { plan.launch.push(rec); slots--; } else plan.queued.push(rec);
  }
  return plan;
}
