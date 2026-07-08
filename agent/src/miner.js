// VoiceDrop article miner — port of mining/mine.py to Cloudflare Workers JS.
// Runs as a Durable Object alarm (Miner class, exported from index.js) on
// every schedule tick or POST /agent/mine/trigger. WeChat auto-push is omitted
// (the relay_server.py handles it on-demand from the app).
//
// Secrets required (wrangler secret put):
//   CLAUDE_API_KEY         Anthropic API key
//   FILES_TOKEN            admin token for jianshuo.dev/files
//   VOLC_ASR_APPID         Volcano ASR app id
//   VOLC_ASR_ACCESS_TOKEN  Volcano ASR access token
//   R2_ACCOUNT_ID          Cloudflare account id (for presigning audio URLs)
//   R2_ACCESS_KEY_ID       R2 S3-compatible access key
//   R2_SECRET_ACCESS_KEY   R2 S3-compatible secret key

import { loadPrompts } from "./prompts/loader.js";
import { writeLlmLog } from "./llmlog.js";
import { callAnthropic } from "./anthropic.js";
import { gateDecision, claudeCostUY, asrCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";
import { hmacSign } from "../../functions/lib/auth.js";
import { TITLE_FALLBACK, resolveArticles } from "../../functions/lib/article-store.js";
import { readStyleText, readProfileName, readStyleDoc, resolveStyle, ensureStyleSeeded, writeStyleDoc } from "../../functions/lib/style-store.js";
import { shareIdFor, communityKey } from "../../functions/lib/community-store.js";
import { distillStyle, buildStyleIntroArticle, buildInsufficientCorpusArticle, corpusChars, MIN_CORPUS_CHARS } from "./style-extract.js";
import {
  MINE_SYSTEM as SYSTEM,
  MINE_SYSTEM_FORCE as SYSTEM_FORCE,
  PHOTO_INSTR as _PHOTO_INSTR,
  MINE_DEFAULT_STYLE as DEFAULT_STYLE,
  IMAGE_ONLY_SYSTEM,
} from "./prompts/mine.js";
import { MOD_CATEGORIES, buildModerationSystem } from "./prompts/moderation.js";
import { mineImageOnly, rewriteFromVision, buildFactPack, makeStageCaller } from "./image-mine.js";

export const MINE_MODEL_DEFAULT = "claude-opus-4-8";
const MIN_CHARS          = 20;
const ORIGIN             = "https://jianshuo.dev";

// ── Resumable ASR tuning ──────────────────────────────────────────────────────
// Volcano ASR is async and slow for long audio (a 60-min file takes minutes to
// transcribe). We must NOT poll it to completion inside one Worker/DO invocation:
// every poll is a subrequest, and long audio blows the per-invocation subrequest
// limit ("Too many subrequests") — the recording then errors at ~90s, leaves no
// marker, and is retried forever. Instead: submit once, persist {taskId,logId} to
// an R2 sidecar, poll only a few times per pass, and let the alarm resume next pass.
const ASR_POLLS_PER_PASS   = 3;                 // ≤3 ASR subrequests per audio per pass
const ASR_POLL_INTERVAL_MS = 2000;             // wait between polls within one pass
const ASR_MAX_AGE_MS       = 30 * 60 * 1000;   // give up (mark empty) if not done in 30 min across passes
const MINE_SUBREQ_BUDGET   = 30;               // ~fetch-subrequests to spend per invocation before deferring
const MINE_RESUME_MS       = 10 * 1000;        // reschedule the alarm this soon while work remains
export { ASR_MAX_AGE_MS, MINE_RESUME_MS };

// ── Model config (R2 `config/model.json`, falls back to env + default) ─────────

export const PROVIDER_ENV_KEY = {
  "anthropic":  "CLAUDE_API_KEY",
  "openai":     "OPENAI_API_KEY",
  "deepseek":   "DEEPSEEK_API_KEY",
  "moonshot":   "MOONSHOT_API_KEY",
  "qwen":       "QWEN_API_KEY",
  "hunyuan":    "HUNYUAN_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "volc-ark":   "VOLC_ARK_API_KEY",
};

export async function loadModelConfig(env) {
  try {
    const obj = await env.FILES.get("config/model.json");
    if (obj) {
      const cfg = await obj.json();
      const providerKey = cfg.providerKey || "anthropic";
      const provider    = providerKey === "anthropic" ? "anthropic" : "openai-compat";
      const envKey      = PROVIDER_ENV_KEY[providerKey];
      const apiKey      = envKey ? (env[envKey] || "") : "";
      return {
        providerKey,
        provider,
        model:   cfg.model   || MINE_MODEL_DEFAULT,
        baseUrl: cfg.baseUrl || "",
        apiKey,
        imagePipeline: cfg.imagePipeline === true,
      };
    }
  } catch (_) {}
  return { providerKey: "anthropic", provider: "anthropic", model: MINE_MODEL_DEFAULT, baseUrl: "", apiKey: env.CLAUDE_API_KEY || "", imagePipeline: false };
}

// Voice editing runs an Anthropic tool-use loop (Claude only). It's a quick,
// mechanical rewrite where latency matters far more than raw quality, so it uses
// a faster / cheaper model than the mining model by default — deliberately
// decoupled from the mining model (which is quality-critical). An explicit Claude
// `editModel` in config/model.json overrides; the mining provider/model is
// irrelevant to editing.
export const EDIT_MODEL_DEFAULT = "claude-sonnet-4-6";

export function resolveEditModel(modelCfg) {
  const m = modelCfg && modelCfg.editModel;
  return (typeof m === "string" && m.startsWith("claude-")) ? m : EDIT_MODEL_DEFAULT;
}

const ARTICLES_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          // 注意：Anthropic output_config 的 schema 不支持 maxItems（线上 400）——
          // 上限 3 条由 prompt 约定 + parseArticles 的 slice(0,3) 双重保证。
          questions: { type: "array", items: { type: "string" } },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["articles"],
  additionalProperties: false,
};

// ── Path helpers ───────────────────────────────────────────────────────────────

function userPrefix(key) {
  if (key.includes("/articles/")) return key.split("/articles/")[0] + "/";
  const i = key.lastIndexOf("/");
  return i > 0 ? key.slice(0, i + 1) : "";
}

// Leaf filename minus its extension. Works for any source — `.m4a` recordings,
// `.txt` shared text, `.docx` style docs — so the article/marker key for an item
// is independent of which kind of file it came from.
function stemOf(key) {
  return key.split("/").pop().replace(/\.[^./]+$/, "");
}

function sessionTs(audioKey) {
  const parts = stemOf(audioKey).split("-");
  return (parts.length >= 5 && parts[0] === "VoiceDrop") ? parts.slice(1, 5).join("-") : null;
}

function articleKeyFor(key) {
  const parts = key.split("/"); const stem = stemOf(key); parts.pop();
  return `${parts.join("/")}/articles/${stem}.json`;
}

function emptyKeyFor(key) {
  const parts = key.split("/"); const stem = stemOf(key); parts.pop();
  return `${parts.join("/")}/articles/${stem}.empty`;
}

// Pending ASR task sidecar: holds {taskId, logId, submittedAt} between passes so a
// long transcription RESUMES instead of re-submitting. Distinct from the
// `.json`/`.empty` markers, so the audio stays "unprocessed" until truly done.
export function asrTaskKeyFor(key) {
  const parts = key.split("/"); const stem = stemOf(key); parts.pop();
  return `${parts.join("/")}/articles/${stem}.asr.json`;
}

// Per-user 训练风格 corpus entry for a shared style submission. The sample file's
// existence doubles as the "already collected" marker (skip on the next run).
function styleSampleKeyFor(key) {
  return `${userPrefix(key)}style/${stemOf(key)}.json`;
}

// "users/<sub>/VoiceDrop-stem.<ext>" → "<sub>/VoiceDrop-stem"  (admin article API path)
function adminArticlePath(key) {
  const prefix = userPrefix(key);
  const sub = prefix.startsWith("users/") ? prefix.slice(6, -1) : prefix.slice(0, -1);
  return `${sub}/${stemOf(key)}`;
}

// The admin article HTTP API writes to users/<sub>/articles/<stem>.json and can't
// handle a stem under a subfolder (e.g. the Android app uploads to
// users/<sub>/upload/VoiceDrop-*.m4a → adminArticlePath = "<sub>/upload/<stem>" →
// admin parses stem="upload", subaction="<stem>" → 400 bad request). Such recordings
// fail every run and, staying "unprocessed", POISON the bounded oldest-first queue and
// starve directly-uploaded (iOS) recordings. Skip them here until the write path
// supports subfolders — a directly-uploaded recording yields exactly "<sub>/<stem>".
function minableViaAdminApi(key) {
  return adminArticlePath(key).split("/").length === 2;
}

// Decide whether to mine this recording. too-long ignores balance; otherwise
// lazy-create the account (first touch grants 500) then check balance.
export async function meteredMineGate(db, scope, durationSec, now) {
  if (durationSec > 3 * 3600) return "too-long";
  if (!db) return "ok";                 // fail-open: no D1 binding
  try {
    const bal = await ensureAccount(db, scope, now);
    return gateDecision(bal, durationSec);
  } catch { return "ok"; }              // fail-open on D1 error
}

// A placeholder recording tagged as a "task" — a job that rides the mining flow
// (upload → 待处理→处理中→已成文 progress in 我的录音) but does something other than
// ASR+挖文章. The tag lives in the FILENAME, same as VoiceDrop-style-/VoiceDrop-mine-
// (no sidecar): the trailing place-token is `Task<Type>` (+ a separate `Keep` token to
// retain any consumed corpus). e.g. …-Morning-TaskStyleExtract.m4a → style-extract, clear;
// …-Morning-TaskStyleExtract-Keep.m4a → style-extract, keep. Returns {type,clearAfter}|null.
export function taskSpec(key) {
  const tokens = stemOf(key).split("-");
  const tok = tokens.find((t) => /^Task[A-Z][A-Za-z0-9]*$/.test(t));
  if (!tok) return null;
  const type = tok.slice(4).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(); // StyleExtract → style-extract
  return { type, clearAfter: !tokens.includes("Keep") };
}

// Route a freshly-listed R2 key to a pipeline. The app's Share Extension tags
// shared items with a filename prefix (VoiceDrop-mine-* / VoiceDrop-style-*);
// in-app recordings keep their plain VoiceDrop-<date>-… name and mine as audio.
//   "audio"     → ASR → articles (in-app recordings + shared .m4a for 挖文章)
//   "mine-text" → shared text/links for 挖文章; skip ASR, the text IS the transcript
//   "style"     → shared text/word/links for 训练风格; collected into the corpus
//   "task"      → tagged placeholder .m4a (Task<Type> in the name) → runTask by type
//   null        → not ours, an output/marker, or a type we don't mine yet
//                 (shared images for 挖文章 and .docx text extraction are deferred)
export function classifyKey(key) {
  if (key.includes("/articles/") || key.includes("/style/")) return null;
  const leaf = key.split("/").pop();
  if (!leaf.startsWith("VoiceDrop-")) return null;
  const ext = (leaf.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  if (leaf.startsWith("VoiceDrop-style-")) return "style";
  if (leaf.startsWith("VoiceDrop-mine-") && (ext === "txt" || ext === "md")) return "mine-text";
  if (ext === "m4a") return taskSpec(key) ? "task" : "audio";
  return null;
}

// ── R2 presigned URL (manual SigV4 — no extra dependencies) ───────────────────

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function presignR2(key, env) {
  const enc = new TextEncoder();
  const region = "auto", service = "s3";
  const bucket = env.R2_BUCKET || "jianshuo-dev-files";
  const host   = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now    = new Date();
  const dateStr = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 8);
  const timeStr = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const credential = `${env.R2_ACCESS_KEY_ID}/${dateStr}/${region}/${service}/aws4_request`;

  const qps = new URLSearchParams({
    "X-Amz-Algorithm":    "AWS4-HMAC-SHA256",
    "X-Amz-Credential":   credential,
    "X-Amz-Date":         timeStr,
    "X-Amz-Expires":      "3600",
    "X-Amz-SignedHeaders": "host",
  });
  qps.sort();

  const canonicalUri = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const canonicalReq = ["GET", canonicalUri, qps.toString(), `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const hashed = hex(await crypto.subtle.digest("SHA-256", enc.encode(canonicalReq)));
  const sts = ["AWS4-HMAC-SHA256", timeStr, `${dateStr}/${region}/${service}/aws4_request`, hashed].join("\n");

  const hmac = async (k, data) => {
    const key2 = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key2, enc.encode(data)));
  };
  const kDate    = await hmac(enc.encode("AWS4" + env.R2_SECRET_ACCESS_KEY), dateStr);
  const kRegion  = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSign    = await hmac(kService, "aws4_request");
  const sig      = hex(await hmac(kSign, sts));

  return `https://${host}${canonicalUri}?${qps}&X-Amz-Signature=${sig}`;
}

// ── Volcano ASR ────────────────────────────────────────────────────────────────

export class AsrError extends Error {
  constructor(code) { super(`ASR deterministic error ${code}`); this.code = String(code); }
}

// Volcano status codes follow an HTTP-like convention:
//   2000000x  success / in-progress
//   45xxxxxx  client/request error — bad audio, wrong format, empty clip, bad params.
//             DETERMINISTIC: re-running gets the same code, so mark the recording
//             empty and stop retrying (an AsrError).
//   55xxxxxx  server internal error — busy / transient fault. Volcano's own SLA
//             defines a 5xx as a "service failure" (their side), i.e. TRANSIENT.
//             Re-running may succeed, so it must NOT permanently mark a recording
//             that has speech as 无语音. Treated as retryable (not an AsrError).
// Only the 45xxxxxx client class is deterministic. Everything else non-success /
// non-in-progress (55xxxxxx, or any unknown code) is treated as retryable — we bias
// toward never losing a real recording; the ASR_MAX_AGE_MS guard stops a wedged task.
function isDeterministicAsrCode(code) {
  return /^45\d{6}$/.test(String(code));
}

async function asrSubmit(audioUrl, env) {
  const taskId = crypto.randomUUID();
  const resp = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit", {
    method: "POST",
    headers: {
      "X-Api-App-Key":     env.VOLC_ASR_APPID,
      "X-Api-Access-Key":  env.VOLC_ASR_ACCESS_TOKEN,
      "X-Api-Resource-Id": "volc.bigasr.auc",
      "X-Api-Request-Id":  taskId,
      "X-Api-Sequence":    "-1",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      user: { uid: "wjs-asr" },
      audio: { format: "m4a", url: audioUrl, codec: "raw" },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true },
    }),
  });
  await resp.text();
  const code = resp.headers.get("X-Api-Status-Code") || "";
  if (code !== "20000000") {
    // Deterministic client error → give up (mark empty). Transient server error /
    // unknown / HTTP failure → throw a plain Error so the caller retries next pass.
    if (isDeterministicAsrCode(code)) throw new AsrError(code);
    throw new Error(`ASR submit failed (transient) ${code || `http-${resp.status}`}`);
  }
  return { taskId, logId: resp.headers.get("X-Tt-Logid") || "" };
}

// Bounded poll: check the task at most `maxPolls` times this pass.
//   { status: "done", data }  — transcription ready
//   { status: "pending" }     — still processing; resume next pass
//   throws AsrError           — deterministic Volcano failure (caller marks empty)
async function asrPollBounded({ taskId, logId }, env, maxPolls) {
  const hdrs = {
    "X-Api-App-Key":     env.VOLC_ASR_APPID,
    "X-Api-Access-Key":  env.VOLC_ASR_ACCESS_TOKEN,
    "X-Api-Resource-Id": "volc.bigasr.auc",
    "X-Api-Request-Id":  taskId,
    "X-Tt-Logid":        logId,
    "X-Api-Sequence":    "-1",
    "Content-Type":      "application/json",
  };
  for (let i = 0; i < maxPolls; i++) {
    const resp = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
      { method: "POST", headers: hdrs, body: JSON.stringify({ task_id: taskId }) });
    const code = resp.headers.get("X-Api-Status-Code") || "";
    const text = await resp.text();
    let res;
    // Malformed body is a transient server hiccup, not a verdict about the audio —
    // throw a plain Error (retry next pass), never an AsrError (which would lose it).
    try { res = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`ASR query bad-json (transient) ${code || resp.status}`); }
    if (code === "20000000" || res.audio_info?.duration || res.result?.text?.trim()) return { status: "done", data: res };
    // Deterministic client error (45xxxxxx) → give up, caller marks empty.
    if (isDeterministicAsrCode(code)) throw new AsrError(code);
    // Otherwise — in-progress (2000000x), transient server error (55xxxxxx), or any
    // unknown code — keep polling and resume next pass; ASR_MAX_AGE_MS bounds a wedged task.
    if (i < maxPolls - 1) await new Promise(r => setTimeout(r, ASR_POLL_INTERVAL_MS));
  }
  return { status: "pending" };
}

// 从 VoiceDrop 文件名的 <dur> 段解析音频时长(秒)。命名规范见 voicedrop/admin/index.html:
//   VoiceDrop-<date>-<HHMMSS>-<dur>-<weekday>-…   <dur> 形如 67m12s 或 45s,且可整段缺省。
// 锚定「数字+(m 数字)?+s」且其后紧跟 `-`/`.`/结尾,避免把 HHMMSS 时间段误判成时长。
function audioDurationSeconds(key) {
  const m = key.match(/-(?:(\d+)m)?(\d+)s(?=[-.]|$)/);
  return m ? parseInt(m[1] || 0, 10) * 60 + parseInt(m[2], 10) : null;
}

// Resumable transcription. Returns:
//   { status: "done", transcript, srt, asrDurMs }  — ready
//   { status: "pending" }                          — still processing; the alarm resumes next pass
//   throws AsrError                                 — deterministic failure / aged-out (caller marks empty)
export async function transcribeResumable(audioKey, env, log) {
  const sideKey = asrTaskKeyFor(audioKey);

  // Resume an in-flight task, or submit a new one.
  let task = null;
  const side = await env.FILES.get(sideKey);
  if (side) { try { task = JSON.parse(await side.text()); } catch { task = null; } }

  if (!task || !task.taskId) {
    const audioUrl = await presignR2(audioKey, env);
    task = await asrSubmit(audioUrl, env);          // throws AsrError on submit failure
    task.submittedAt = Date.now();
    await env.FILES.put(sideKey, JSON.stringify(task), { httpMetadata: { contentType: "application/json" } });
    log?.("ASR 已提交", { taskId: String(task.taskId).slice(0, 8) });
  } else {
    log?.("ASR 续查", { taskId: String(task.taskId).slice(0, 8), age_s: Math.round((Date.now() - (task.submittedAt || Date.now())) / 1000) });
  }

  const r = await asrPollBounded(task, env, ASR_POLLS_PER_PASS);
  if (r.status === "pending") {
    // Aged-out guard: a wedged task can't loop forever. Caller will mark empty.
    if (task.submittedAt && Date.now() - task.submittedAt > ASR_MAX_AGE_MS) throw new AsrError("timeout");
    return { status: "pending" };
  }

  await env.FILES.delete(sideKey).catch(() => {});
  const result = r.data.result || {};
  const utts   = result.utterances || [];
  const text   = (result.text || "").trim() || utts.map(u => u.text || "").join("").trim();
  return { status: "done", transcript: text, srt: buildSrt(utts), asrDurMs: r.data.audio_info?.duration };
}

// ── SRT builder ────────────────────────────────────────────────────────────────

function msToTs(ms) {
  ms = Math.max(0, Math.floor(ms));
  const h = Math.floor(ms / 3600000); ms %= 3600000;
  const m = Math.floor(ms / 60000);   ms %= 60000;
  const s = Math.floor(ms / 1000);    ms %= 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

function buildSrt(utterances) {
  const lines = []; let idx = 1, prevEnd = 0;
  for (const u of utterances) {
    const text = (u.text || "").trim(); if (!text) continue;
    const start = u.start_time || prevEnd;
    const end   = Math.max(start + 1, u.end_time || start + 2000);
    lines.push(`${idx}\n${msToTs(start)} --> ${msToTs(end)}\n${text}\n`);
    prevEnd = end; idx++;
  }
  return lines.join("\n");
}

// ── Article JSON parsing ───────────────────────────────────────────────────────

// 追问只许走 "questions" 字段；prompt 已禁止写进正文，这里是不靠模型自觉的
// 程序化兜底（ensurePhotoMarkers 同款原则）：正文尾部的「——追问——」节一律剥掉。
const ZHUIWEN_SECTION_RE = /\n+[ \t]*——追问——[ \t]*\n[\s\S]*$/;

export function parseArticles(text) {
  let t = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j > i) t = t.slice(i, j + 1);
  const obj  = JSON.parse(t);
  const arts = Array.isArray(obj) ? obj : (obj.articles || []);
  return arts
    .filter(a => typeof a === "object" && (a.body || "").trim())
    .map(a => {
      const questions = (Array.isArray(a.questions) ? a.questions : [])
        .map(q => String(q || "").trim()).filter(Boolean).slice(0, 3);
      return {
        title: (a.title || TITLE_FALLBACK).trim(),
        body: (a.body || "").replace(ZHUIWEN_SECTION_RE, "").trim(),
        ...(questions.length ? { questions } : {}),
      };
    });
}

// 把模型按篇给出的 questions 收进 doc 顶层 sidecar（{id, articleIndex, text,
// status, createdAt}），并从 article 对象上摘掉该字段——追问不进版本内容、不进
// 正文，发布/分享/合并的每个出口天然不带它。
export function extractFollowups(articles, now = Date.now()) {
  const questions = [];
  const cleaned = (articles || []).map((a, ai) => {
    const { questions: qs, ...rest } = a || {};
    (Array.isArray(qs) ? qs : []).forEach((t, qi) => {
      const text = String(t || "").trim();
      if (text) questions.push({ id: `q${now}-${ai}-${qi}`, articleIndex: ai, text, status: "pending", createdAt: now });
    });
    return rest;
  });
  return { articles: cleaned, questions };
}

// ── Photos ────────────────────────────────────────────────────────────────────

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  return btoa(bin);
}

async function loadPhoto(photoKey, env) {
  const obj = await env.FILES.get(photoKey);
  if (!obj) return null;
  const b64  = bufToB64(await obj.arrayBuffer());
  const name = photoKey.split("/").pop().replace(/\.jpe?g$/i, "");
  const parts = name.split("-");
  const label = (parts.length >= 4 && parts[3]?.length === 6)
    ? `${parts[3].slice(0,2)}:${parts[3].slice(2,4)}:${parts[3].slice(4)}` : name;
  // Relative key (drop the users/<sub>/ prefix) — matches doc.photos and is the
  // token the model writes into [[photo:<key>]] markers.
  const i = photoKey.indexOf("photos/");
  const relKey = i >= 0 ? photoKey.slice(i) : photoKey;
  return { b64, label, relKey };
}

function findSessionPhotos(audioKey, allKeys) {
  const prefix = userPrefix(audioKey);
  const ts     = sessionTs(audioKey);
  if (!ts) return [];
  const folder = `${prefix}photos/${ts}/`;
  return allKeys.filter(k => k.startsWith(folder) && /\.jpe?g$/i.test(k)).sort();
}

// Collect + load this recording's session photos (photos/<sessionTs>/*.jpg). Single
// shared mechanism for both the has-speech mine and the no-speech-but-photos path —
// same keys, same loader, same "skip a photo that fails to load" behavior.
async function gatherPhotos(audioKey, allKeys, env, log = () => {}) {
  const photoKeys = findSessionPhotos(audioKey, allKeys);
  const photos = [];
  for (const pk of photoKeys) {
    try { const p = await loadPhoto(pk, env); if (p) photos.push(p); }
    catch (e) { log("照片加载失败", { key: pk, err: e.message }); }
  }
  return photos;
}

// ── Claude (article generation) ───────────────────────────────────────────────

// cacheMode picks the prompt-cache layout (Anthropic only; ignored for openai-compat):
//   "system"     (default) — 文风 rides in the cached system block. Best when the SAME
//                文风 is reused across DIFFERENT recordings (normal mining): system
//                (SYSTEM+文风) is the stable prefix, the transcript varies per recording.
//   "transcript" — 文风 rides at the END of the user message, after the (large, stable)
//                transcript+photos, which become the cached prefix. Best when the SAME
//                recording is re-run with DIFFERENT 文风 (restyle / 单篇多文风): the bulky
//                transcript+photos (often 10k+ tokens) are read from cache and only the
//                文风 tail varies. Images can't sit in a system block, so caching photos
//                across 文风 variants REQUIRES this layout.
// A log-friendly copy of the request body: image base64 can be megabytes, so swap
// it for a tiny placeholder (the llmlog R2 object must stay small). Everything else
// is kept verbatim so admin/llm.html can replay model / system / messages / tools.
function redactReqForLog(payload) {
  const tag = (s) => `[base64 image · ~${Math.round((String(s).length * 3) / 4 / 1024)}KB elided]`;
  const req = { ...payload };
  if (Array.isArray(req.messages)) {
    req.messages = req.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      return { ...m, content: m.content.map((b) => {
        if (b?.type === "image" && b.source?.data) return { ...b, source: { ...b.source, data: tag(b.source.data) } };
        if (b?.type === "image_url" && b.image_url?.url) return { ...b, image_url: { ...b.image_url, url: tag(b.image_url.url) } };
        return b;
      }) };
    });
  }
  return req;
}

// Pure prompt/payload builder — no env, no fetch, no billing/logging side effects.
// Shared by production generateArticles AND the eval harness (agent/eval/run-eval.mjs)
// so the prompt bytes are identical. cacheMode/provider behavior unchanged.
export function buildMinePrompt({
  transcript, styleText, photos, force, cacheMode = "system",
  provider = "anthropic", model,
  systemPrompt = SYSTEM, forcePrompt = SYSTEM_FORCE,
  photoInstr = _PHOTO_INSTR, defaultStyle = DEFAULT_STYLE,
}) {
  const hasPhotos = !!(photos?.length) && !force;
  const staticSystem = force ? forcePrompt : (systemPrompt + (hasPhotos ? photoInstr : ""));
  const effectiveStyle = (styleText && styleText.trim()) ? styleText.trim() : defaultStyle;
  const styleTail = !force ? `\n\n<style>\n${effectiveStyle}\n</style>` : "";
  const transcriptText = `<transcript>\n${transcript}\n</transcript>`;
  const transcriptCache = cacheMode === "transcript" && !force;

  if (provider === "openai-compat") {
    const system = staticSystem + styleTail;
    let userContent;
    if (!hasPhotos) {
      userContent = transcriptText;
    } else {
      userContent = [{ type: "text", text: transcriptText }];
      for (let i = 0; i < photos.length; i++) {
        userContent.push({ type: "text", text: `\n<photo key="${photos[i].relKey}" time="${photos[i].label}">` });
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photos[i].b64}`, detail: "low" } });
        userContent.push({ type: "text", text: `\n</photo>` });
      }
    }
    return {
      model,
      max_tokens: force ? 2000 : 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    };
  }

  // Anthropic — prompt caching via cache_control breakpoints
  const systemText = transcriptCache ? staticSystem : (staticSystem + styleTail);
  const systemBlocks = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
  let content;
  if (!hasPhotos) {
    if (transcriptCache) {
      content = [{ type: "text", text: transcriptText, cache_control: { type: "ephemeral" } }];
      if (styleTail) content.push({ type: "text", text: styleTail });
    } else {
      content = transcriptText;
    }
  } else {
    content = [{ type: "text", text: transcriptText }];
    for (let i = 0; i < photos.length; i++) {
      content.push({ type: "text", text: `\n<photo key="${photos[i].relKey}" time="${photos[i].label}">` });
      const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos[i].b64 } };
      if (transcriptCache && i === photos.length - 1) img.cache_control = { type: "ephemeral" };
      content.push(img);
      content.push({ type: "text", text: `\n</photo>` });
    }
    if (transcriptCache && styleTail) content.push({ type: "text", text: styleTail });
  }
  const payload = {
    model, max_tokens: force ? 2000 : 8000,
    system: systemBlocks,
    messages: [{ role: "user", content }],
  };
  if (!force) payload.output_config = { format: { type: "json_schema", schema: ARTICLES_SCHEMA } };
  return payload;
}

async function generateArticles(transcript, claudeMd, photos, force, env, modelCfg, cacheMode = "system", systemOverride = null, photoInstr = undefined) {
  const _P = await loadPrompts(env);
  const payload = buildMinePrompt({
    transcript, styleText: claudeMd, photos, force, cacheMode,
    provider: modelCfg.provider, model: modelCfg.model,
    systemPrompt: systemOverride || _P["mine.system"],
    forcePrompt: _P["mine.force"],
    // Explicit "" (image-only vision path) must win over buildMinePrompt's PHOTO_INSTR
    // default; omitted (undefined) leaves every other caller's behavior unchanged.
    ...(photoInstr !== undefined ? { photoInstr } : {}),
  });
  const reqForLog = redactReqForLog(payload);
  const t0 = Date.now();
  let text, latencyMs, rawResp;

  if (modelCfg.provider === "openai-compat") {
    const resp = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${modelCfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    latencyMs = Date.now() - t0;
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    rawResp = await resp.json();
    text = rawResp.choices?.[0]?.message?.content || "";
  } else {
    const r = await callAnthropic(env, payload, { apiKey: modelCfg.apiKey });
    latencyMs = Date.now() - t0;
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(r.errorText || "").slice(0, 200)}`);
    rawResp = r.json;
    text = (rawResp.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }

  return { articles: parseArticles(text), latencyMs, rawResp, request: reqForLog };
}

// ── Content moderation (Apple App Store 1.2 — filter objectionable UGC) ────────
// Judged ONCE here at generation time and stamped onto the article doc as
// `moderation:{flagged,categories,at}`. The community-share route only READS this
// flag (no second LLM call) and refuses to publish a flagged article. Anthropic
// (haiku) regardless of the mining provider, so moderation stays reliable + cheap.
// Fail-open on any infra error (don't block legit content) — report/block still cover it.
// MOD_CATEGORIES / buildModerationSystem now live in ./prompts/moderation.js (imported above).
export async function moderateArticles(articles, env) {
  if (!env.CLAUDE_API_KEY) return { flagged: false, skipped: "no-key" };
  const text = (articles || []).map(a => `${a.title || ""}\n${a.body || ""}`).join("\n\n").trim().slice(0, 16000);
  if (!text) return { flagged: false };
  const system = buildModerationSystem();
  try {
    const r = await callAnthropic(env, { model: "claude-haiku-4-5-20251001", max_tokens: 200,
      system, messages: [{ role: "user", content: text }] });
    if (!r.ok) return { flagged: false, error: `http-${r.status}` };
    const j = r.json;
    const out = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const m = out.match(/\{[\s\S]*\}/);
    const v = m ? JSON.parse(m[0]) : {};
    return { flagged: !!v.flagged, categories: Array.isArray(v.categories) ? v.categories : [], at: Date.now() };
  } catch (e) {
    return { flagged: false, error: String((e && e.message) || e) };
  }
}

// ── Article API writes (via versioned article API so history is preserved) ─────

async function apiPut(path, body, contentType, env) {
  const resp = await fetch(`${ORIGIN}/files/api/${path}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${env.FILES_TOKEN}`, "Content-Type": contentType },
    body,
  });
  if (!resp.ok) throw new Error(`PUT ${path} → ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

async function writeArticle(audioKey, doc, env) {
  await apiPut(`articles/${adminArticlePath(audioKey)}`, JSON.stringify(doc), "application/json", env);
}

// 录音从某个标签页发起时，App 先放好 articles/<stem>.tags 侧车（["标签", …]）。
// 首次成文前消费它：返回标签数组并删除侧车——只生效一次，之后用户语音删掉的
// 标签不会被 re-mine / restyle 复活。Best-effort：侧车坏/读失败返回 []，不阻塞成文。
export async function consumePendingTags(audioKey, env) {
  try {
    const tagsKey = articleKeyFor(audioKey).replace(/\.json$/, ".tags");
    const side = await env.FILES.get(tagsKey);
    if (!side) return [];
    let tags = [];
    try {
      const parsed = JSON.parse(await side.text());
      if (Array.isArray(parsed)) tags = parsed.map(String).filter(Boolean);
    } catch (_) {}
    await env.FILES.delete(tagsKey);
    return [...new Set(tags)];
  } catch (_) { return []; }
}

async function writeSrt(audioKey, srt, env) {
  await apiPut(`articles/${adminArticlePath(audioKey)}/srt`, srt, "text/plain", env);
}

async function writeEmpty(audioKey, reason, env) {
  await apiPut(`articles/${adminArticlePath(audioKey)}/empty`, JSON.stringify({ reason }), "application/json", env);
}

async function writeBlocked(audioKey, reason, env) {
  await apiPut(`articles/${adminArticlePath(audioKey)}/blocked`, JSON.stringify({ status: "blocked", reason }), "application/json", env);
}

// ── Auto-share to VD社区 ─────────────────────────────────────────────────────────
// When the user has turned on 「自动分享到 VD社区」 (Settings → 发布), the app writes
// `users/<sub>/CONFIG.json` = {autoShareCommunity:true}. After a fresh article lands
// we mirror EXACTLY what the app's POST community/share endpoint does — same shareId
// derivation, same pointer shape — so the post is byte-identical to a manual share:
// the app detects it as 已分享, a re-mine updates the same post in place, and 取消分享
// still works. Best-effort: never blocks or fails mining (caller wraps in try/catch).
// 用户 CONFIG.json（autoShareCommunity / …）——存储细节收口在这，
// 调用方只传 scope。读不到/坏 JSON 一律回空对象，调用方按默认值走。
export async function readUserConfig(env, scope) {
  const obj = await env.FILES.get(scope + "CONFIG.json");
  if (!obj) return {};
  try { return JSON.parse(await obj.text()) || {}; } catch { return {}; }
}

export async function maybeAutoShareCommunity(srcKey, env, log = () => {}) {
  if (!env.SESSION_SECRET) return null;            // can't derive shareId without it
  const scope = userPrefix(srcKey);                // users/<sub>/
  const cfg = await readUserConfig(env, scope);
  if (cfg.autoShareCommunity !== true) return null;

  const articleKey = articleKeyFor(srcKey);        // users/<sub>/articles/<stem>.json
  // author — readProfileName 内部封装存储细节与无名兜底，只给 scope。
  const author = await readProfileName(env, scope);

  const shareId = await shareIdFor(articleKey, env.SESSION_SECRET);
  const postKey = communityKey(shareId);
  // Preserve firstSharedAt + replyTo when re-sharing (re-mine), exactly like the endpoint.
  let firstSharedAt = Date.now();
  let replyTo = null;
  const existing = await env.FILES.get(postKey);
  if (existing) {
    try { const ep = JSON.parse(await existing.text()); firstSharedAt = ep.firstSharedAt || firstSharedAt; replyTo = ep.replyTo || null; } catch {}
  }
  const post = { schema: 2, shareId, owner: scope, articleKey, author, firstSharedAt,
                 ...(replyTo ? { replyTo } : {}) };
  await env.FILES.put(postKey, JSON.stringify(post), { httpMetadata: { contentType: "application/json" } });
  log("自动分享到 VD社区", { shareId });
  return shareId;
}

// ── StatusHub notification ─────────────────────────────────────────────────────

async function notifyStatus(scope, stem, status, env) {
  try {
    const stub = env.StatusHub.get(env.StatusHub.idFromName("status:" + scope));
    await stub.fetch(new Request("https://status-hub/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem, status }),
    }));
  } catch (_) {}
}

// ── The ONE place LLM article-mining happens ──────────────────────────────────
// generateArticles + LLM logging + 算力 debit + the natural→force retry, in a single
// core so the scheduled mine (audio + text) AND the on-demand restyle share exactly one
// implementation. They used to be three copies of this closure and drifted — restyle
// once shipped WITHOUT the force retry, so thin / test recordings failed with no-article.
//
// Returns the article array ([] if even the force pass produced nothing; hard LLM errors
// also collapse to [] after both passes, same as the scheduled mine). The force pass
// drops the 文风 + photos to coax an article out of thin content — identical to runMine.
//   cacheMode      — "system" | "transcript" (prompt-cache layout for this call).
//   metaExtra      — extra fields on the LLM-log meta (e.g. { source:"text" } / { restyle:v }).
//   debitExtra     — extra fields on the 算力 ledger meta (e.g. { restyle:v }).
//   label/log      — optional mine-run narration (runMine passes its logger; restyle doesn't).
//   systemOverride — replace the default MINE_SYSTEM prompt for the natural pass only
//                    (e.g. IMAGE_ONLY_SYSTEM for the no-speech-but-photos path). Omitted
//                    → MINE_SYSTEM, i.e. behavior for every existing caller is unchanged.
//   noForce        — skip the force retry when the natural pass returns no articles. The
//                    force pass drops photos/style and coaxes a transcript-only article out
//                    of thin content — meaningless (and prone to inventing facts) when there
//                    is no transcript at all, so the image-only caller sets this true.
//   photoInstr     — override the default PHOTO_INSTR appended after the system prompt when
//                    photos are present. Omitted → PHOTO_INSTR (unchanged for every existing
//                    caller). The image-only vision path passes "" — PHOTO_INSTR talks about
//                    口述/"一边说一边拍" (spoken narration), which doesn't apply when there is
//                    no speech at all; IMAGE_ONLY_SYSTEM already carries its own complete
//                    instructions, including the [[photo:<key>]] marker guidance.
async function mineVariant(env, {
  transcript, styleText, photos, cacheMode, modelCfg, scope, stem, turnId,
  metaExtra = {}, debitExtra = {}, label = "", log = () => {},
  systemOverride = null, noForce = false, photoInstr = undefined,
}) {
  const meta = { user_scope: scope, stem, ...metaExtra };
  const tag = label ? " " + label : "";
  const runLlm = async (force, step) => {
    const tLlm = Date.now();
    log(`LLM 开始${tag}${force ? " (force)" : ""}`, { step });
    try {
      const r = await generateArticles(transcript, force ? "" : styleText, force ? null : (photos && photos.length ? photos : null), force, env, modelCfg, cacheMode, systemOverride, photoInstr);
      await writeLlmLog(env, { ts: tLlm, source: "mine", ok: true, status: 200, model: modelCfg.model, latency_ms: r.latencyMs, step, turn_id: turnId, meta, request: r.request, response: r.rawResp });
      try {
        if (env.USAGE) {
          const u = r.rawResp?.usage || {};
          await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
            "mine", { model: modelCfg.model, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId, ...debitExtra }, Date.now());
        }
      } catch (_) {}
      log(`LLM 完成${tag}${force ? " (force)" : ""}`, { articles: r.articles.length, latency_ms: r.latencyMs });
      return r.articles;
    } catch (e) {
      await writeLlmLog(env, { ts: tLlm, source: "mine", ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now() - tLlm, step, turn_id: turnId, meta, error: String(e) });
      throw e;
    }
  };
  let arts = await runLlm(false, 0);
  if (!arts.length && !noForce) { log("LLM 无文章，重试 (force)"); try { arts = await runLlm(true, 1); } catch (_) { arts = []; } }
  return arts;
}

// ── On-demand restyle ─────────────────────────────────────────────────────────
// Re-mine ONE existing article with a chosen 文风 version → a new article version
// tagged `articles[i].style = N`, head moves to it. Reuses the mining LLM path so the
// rewrite reads exactly like a first-time mine; re-feeds session photos so [[photo:…]]
// markers are re-placed. The app already handles "switch to an existing variant" via
// patchHead — this is only the generate path. Returns {ok, head?} / {ok:false, reason}.
// 解析要用哪个文风版本：显式整数 styleV 优先；缺省则用文风 doc 的当前 head（重写场景）。
// 都没有 → null（调用方随后按 no-style 处理）。
export function resolveStyleVersion(styleDoc, styleV) {
  if (Number.isInteger(styleV)) return styleV;
  return (styleDoc && Number.isInteger(styleDoc.head)) ? styleDoc.head : null;
}

// ── 照片标记保底 ────────────────────────────────────────────────────────────────
// LLM 改写（restyle / merge）绝不允许丢照片。prompt 已经要求保留，这里是不靠模型
// 自觉的程序化兜底：凡是源文章里出现过、新稿里没有的 [[photo:key]]，按原顺序补到
// 新稿最后一篇的末尾（独占一行）。位置可能不完美，但照片一定都在。
const PHOTO_MARKER_RE = /\[\[photo:([^\]]+)\]\]/g;

export function photoKeysIn(articles) {
  const keys = [];
  for (const a of articles || []) {
    for (const m of String(a?.body || "").matchAll(PHOTO_MARKER_RE)) {
      if (!keys.includes(m[1])) keys.push(m[1]);
    }
  }
  return keys;
}

export function ensurePhotoMarkers(sourceArticles, newArticles) {
  if (!Array.isArray(newArticles) || !newArticles.length) return newArticles;
  const have = new Set(photoKeysIn(newArticles));
  const missing = photoKeysIn(sourceArticles).filter((k) => !have.has(k));
  if (!missing.length) return newArticles;
  const out = newArticles.map((a) => ({ ...a }));
  const last = out[out.length - 1];
  last.body = `${String(last.body || "").replace(/\s+$/, "")}\n\n${missing.map((k) => `[[photo:${k}]]`).join("\n\n")}\n`;
  return out;
}

export async function restyleArticle(env, scope, stem, styleV) {
  const articleKey = `${scope}articles/${stem}.json`;
  const obj = await env.FILES.get(articleKey);
  if (!obj) return { ok: false, reason: "not-found" };
  let doc; try { doc = JSON.parse(await obj.text()); } catch { return { ok: false, reason: "corrupt" }; }
  const transcript = (doc.transcript || "").trim();
  // 合并 / 图片 / 独立文章没有口述转写（transcript=""）——正文就是它的事实来源，
  // 用当前 head 文章的正文当改写来源，别再 no-transcript 硬失败。
  const mineSource = transcript || resolveArticles(doc)
    .map((a) => `${a.title || ""}\n${a.body || ""}`.trim()).filter(Boolean).join("\n\n").trim();
  if (!mineSource) return { ok: false, reason: "no-transcript" };

  const styleDoc = await readStyleDoc(env, scope);
  // styleV 缺省（重写：POST /agent/restyle 只带 stem）→ 用当前文风 head，即"按原挖矿逻辑重挖"
  const v = resolveStyleVersion(styleDoc, styleV);
  const entry = styleDoc && Array.isArray(styleDoc.versions) ? styleDoc.versions.find((e) => e.v === v) : null;
  const styleText = entry && typeof entry.style === "string" ? entry.style.trim() : "";
  if (!styleText) return { ok: false, reason: "no-style" };

  // Re-feed this session's photos so the model can re-place [[photo:…]] markers.
  const audioKey = `${scope}${stem}.m4a`;
  const ts = sessionTs(audioKey);
  const photos = [];
  if (ts) {
    const listed = await env.FILES.list({ prefix: `${scope}photos/${ts}/` });
    const keys = (listed.objects || []).map((o) => o.key).filter((k) => /\.jpe?g$/i.test(k)).sort();
    for (const pk of keys) { try { const p = await loadPhoto(pk, env); if (p) photos.push(p); } catch (_) {} }
  }

  const modelCfg = await loadModelConfig(env);
  const turnId = `${Date.now()}-${stem.slice(-8)}`;

  // 图片流水线产物（无转写、doc.vision/plan 在）→ 复用观察与立意，只重跑写作+审稿。
  // 换文风不换立意；照片只在审稿阶段重新入场核对误读。失败静默落回下方 mineVariant。
  let articles = null;
  if (modelCfg.imagePipeline && !transcript && doc.vision && doc.plan && photos.length) {
    try {
      const factPack = await buildFactPack(env, { scope, stem, photos });
      const callModel = makeStageCaller(env, { modelCfg, scope, stem, turnId });
      const r = await rewriteFromVision({
        photos, factPack, vision: doc.vision, plan: doc.plan, styleText,
        provider: modelCfg.provider, model: modelCfg.model, callModel,
      });
      if (r.articles.length) articles = r.articles;
    } catch (_) { articles = null; }
  }
  if (!articles) {
    // Same mining core as the scheduled mine — natural pass then a force retry for thin
    // recordings — so restyle can never again drift from runMine.
    articles = await mineVariant(env, {
      transcript: mineSource, styleText, photos, cacheMode: "transcript", modelCfg, scope, stem, turnId,
      metaExtra: { restyle: v }, debitExtra: { restyle: v },
    });
  }
  if (!articles.length) return { ok: false, reason: "no-article" };

  // 保底：原 head 版本里的每一张照片都必须活着走出改写（prompt 之外的硬保证）。
  articles = ensurePhotoMarkers(resolveArticles(doc), articles);

  // 重挖出的新稿带新一轮追问，整体替换旧 sidecar（追问只属于当前这版正文）。
  const { articles: cleanedArts, questions } = extractFollowups(articles);

  // 文风版本 = per-article 字段（不再往 body 塞注释——隐形行会让第N行编号错位）
  const tagged = cleanedArts.map((a) => ({ ...a, style: v }));
  const newDoc = {
    schema: 2, id: doc.id || stem, sourceAudio: doc.sourceAudio || `${stem}.m4a`,
    createdAt: doc.createdAt || new Date().toISOString(),
    transcript, srt: doc.srt || "", articles: tagged, status: "ready", model: modelCfg.model,
    ...(questions.length ? { questions } : {}),
    // 标签是 doc 级元数据，重写必须原样带上——PUT 是整体替换，漏了就把标签吃掉
    ...(Array.isArray(doc.tags) && doc.tags.length ? { tags: doc.tags } : {}),
    // 流水线元数据随版本继承——下次 restyle 还能继续复用观察与立意
    ...(doc.vision ? { vision: doc.vision } : {}),
    ...(doc.plan ? { plan: doc.plan } : {}),
  };
  await writeArticle(audioKey, newDoc, env);          // appends a new version, head moves to it
  await notifyStatus(scope, stem, "ready", env);
  let head = 0;
  try { head = JSON.parse(await (await env.FILES.get(articleKey)).text()).head || 0; } catch (_) {}
  return { ok: true, head };
}

// writeLlmLog is imported from ./llmlog.js (shared with index.js). Mine calls
// pass source:"mine" in the record.

// ── Mine run log (per-audio, written to R2) ────────────────────────────────────

async function writeMineLog(env, rec) {
  try {
    const day = new Date(rec.ts).toISOString().slice(0, 10);
    await env.FILES.put(
      `minelogs/${day}/${rec.ts}-${rec.stem}.json`,
      JSON.stringify(rec),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch (_) {}
}

// ── Per-audio pipeline ─────────────────────────────────────────────────────────

// ── Task placeholder jobs (extensible) ───────────────────────────────────────
// The task type is read from the filename by `taskSpec` (no sidecar) — see classifyKey.
// Dispatch by task type. Each handler writes articles/<stem>.json (the output) + notifies
// status, returns "mined" | "empty". Add new task types here.
const TASK_HANDLERS = { "style-extract": mineStyleExtract };
async function runTask(task, audioKey, env, modelCfg, log) {
  const handler = TASK_HANDLERS[task && task.type];
  if (!handler) {
    log("未知任务类型", { type: task && task.type });
    await writeEmpty(audioKey, `unknown-task:${(task && task.type) || "?"}`, env);
    await notifyStatus(userPrefix(audioKey), stemOf(audioKey), "empty", env);
    return "empty";
  }
  return await handler(task, audioKey, env, modelCfg, log);
}

// Minimal Claude caller for task handlers (worker CLAUDE_API_KEY; accumulates usage).
function makeTaskClaude(env, model, usage) {
  return async ({ system, messages }) => {
    const r = await callAnthropic(env, { model, max_tokens: 1500, system, messages });
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
    const j = r.json;
    const u = j.usage || {};
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  };
}

// Task「style-extract」: read the 风格数据集 corpus → distill → write a new 写作风格 version +
// write the 写作风格介绍 article as this placeholder's article (the visible output).
async function mineStyleExtract(task, audioKey, env, modelCfg, log) {
  const scope = userPrefix(audioKey);
  const stem = stemOf(audioKey);
  await notifyStatus(scope, stem, "mining", env);

  const samples = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: `${scope}style/`, cursor });
    for (const o of listed.objects) {
      const obj = await env.FILES.get(o.key);
      const s = obj && await obj.json().catch(() => null);
      if (s && (s.text || "").trim()) samples.push(s);
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  const writeReadyArticle = async (title, body) => {
    await writeArticle(audioKey, {
      schema: 2, id: stem, sourceAudio: `${stem}.m4a`, createdAt: new Date().toISOString(),
      transcript: "", srt: "", articles: [{ title, body }], status: "ready", model: "style-extract",
    }, env);
    await notifyStatus(scope, stem, "ready", env);
  };

  if (!samples.length) {
    await writeReadyArticle("风格数据集为空",
      "还没有可提炼的素材。先从别的 app 分享一些你喜欢的文章 / 网页 / 文档进来（会进「风格数据集」），再点「提取文章风格」。\n\n你的写作风格没有被改动，当前生效的还是原来那一版。");
    log("风格数据集为空");
    return "mined";
  }

  // 硬闸：语料有效字数不够（如只分享了书名/链接）就不蒸馏、不落风格版本——否则
  // 蒸馏器的「无法蒸馏」说明卡会被存成新版本并成为生效文风。语料保留，补够再提。
  const totalChars = corpusChars(samples);
  if (totalChars < MIN_CORPUS_CHARS) {
    const { title, body } = buildInsufficientCorpusArticle(samples, totalChars);
    await writeReadyArticle(title, body);
    log("风格语料不足，跳过蒸馏", { totalChars, min: MIN_CORPUS_CHARS });
    return "mined";
  }

  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const style = await distillStyle(samples, makeTaskClaude(env, modelCfg.model, usage));
  await writeStyleDoc(env, scope, style, "share-extract");
  const { title, body } = buildStyleIntroArticle(style, samples);
  await writeReadyArticle(title, body);

  if (task.clearAfter) {
    try {
      for (const prefix of [`${scope}style/`, `${scope}VoiceDrop-style-`]) {
        let c;
        do { const l = await env.FILES.list({ prefix, cursor: c }); for (const o of l.objects) await env.FILES.delete(o.key); c = l.truncated ? l.cursor : null; } while (c);
      }
    } catch (_) {}
  }
  try {
    if (env.USAGE) {
      await ensureAccount(env.USAGE, scope, Date.now());
      await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens), "style-extract", { samples: samples.length }, Date.now());
    }
  } catch (_) {}
  log("风格提取完成", { name: (style.split("\n")[0] || "").slice(0, 12), samples: samples.length });
  return "mined";
}

export async function mineOneAudio(audioKey, allKeys, uploaded, env, modelCfg) {
  const leaf  = audioKey.split("/").pop();
  const scope = userPrefix(audioKey);
  const stem  = stemOf(audioKey);
  const t0    = Date.now();

  const events = [];
  const log = (msg, data) => {
    const entry = { ts: Date.now(), msg };
    if (data !== undefined) entry.data = data;
    events.push(entry);
    console.log(`   ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`);
  };

  let result = "error";
  try {
    // Strongly-consistent check before doing any work
    if (await env.FILES.head(articleKeyFor(audioKey)) || await env.FILES.head(emptyKeyFor(audioKey))) {
      console.log(`   skip (already processed)`);
      result = "skip";
      return "skip";
    }

    // ── Task dispatch ──────────────────────────────────────────────────────────
    // A tagged placeholder rides the same flow as a real recording: the client uploads a
    // (silent) placeholder .m4a whose filename carries a `Task<Type>` token, then triggers
    // the miner. If the name is a task this is NOT a mine — dispatch by type to a handler
    // that does the work and writes articles/<stem>.json (the output, shown in 我的录音 with
    // the same 待处理→处理中→已成文 progress). Add task types to TASK_HANDLERS. First one:
    // "style-extract" (读语料→蒸馏→写风格版本+介绍文章). Tag lives in the filename, not a sidecar.
    const task = taskSpec(audioKey);
    if (task) {
      result = await runTask(task, audioKey, env, modelCfg, log);
      return result;
    }

    // ── Balance gate (pre-ASR) ────────────────────────────────────────────────
    const durSec = audioDurationSeconds(audioKey);
    const decision = await meteredMineGate(env.USAGE, scope, durSec ?? 0, Date.now());
    if (decision === "too-long") { await writeBlocked(audioKey, "too-long", env); return; }
    if (decision === "no-credit") { await writeBlocked(audioKey, "no-credit", env); return; }
    // Drop stale .blocked marker before proceeding (e.g. user topped up)
    try { await env.FILES.delete(`${userPrefix(audioKey)}articles/${stemOf(audioKey)}.blocked`); } catch (_) {}

    // ── ASR (resumable across passes) ───────────────────────────────────────────
    // 0 秒 = 静音占位（图片分享的占位音频，文件名 …-0m0s-…）：没有可转写的语音，直接
    // 跳过 ASR —— 省一趟火山提交+轮询（延迟 + 钱 + subrequest 预算），落到下面的
    // 「无语音 → 有照片就看图」路径。1 秒及以上照常 ASR。
    let transcript, srt, asrDurMs;
    if (durSec === 0) {
      transcript = ""; srt = ""; asrDurMs = 0;
      log("0 秒静音占位,跳过 ASR");
    } else {
      await notifyStatus(scope, stem, "asr", env);
      try {
        const tAsr = Date.now();
        const r = await transcribeResumable(audioKey, env, log);
        if (r.status === "pending") {
          log("ASR 处理中,本趟未完成,下趟续查");
          result = "pending";
          return "pending";
        }
        ({ transcript, srt, asrDurMs } = r);
        log("ASR 完成", { chars: transcript.length, duration_ms: Date.now() - tAsr });
      } catch (e) {
        if (e instanceof AsrError) {
          await env.FILES.delete(asrTaskKeyFor(audioKey)).catch(() => {});
          await writeEmpty(audioKey, `asr-error:${e.code}`, env);
          await notifyStatus(scope, stem, "empty", env);
          log("ASR 错误", { code: e.code });
          result = "empty";
          return "empty";
        }
        // Non-deterministic (network / subrequest budget): record the REAL error so
        // it's visible in the minelog; leave no marker (sidecar persists) → retry next pass.
        log("ASR 失败(非确定性,下趟重试)", { name: e?.name, message: String(e?.message ?? e).slice(0, 200) });
        throw e;
      }
    }

    // Debit ASR cost (best-effort; uses actual ASR duration or filename estimate).
    // asrDurMs is in MILLISECONDS (Volcano ASR audio_info.duration unit).
    try {
      if (env.USAGE) {
        const rawSec = (asrDurMs ?? (durSec ?? 0) * 1000) / 1000;
        // Sanity clamp: a malformed/huge value must not cause 1000x overcharge.
        // Fall back to the filename-parsed durSec (or 0) for absurd values (>6h).
        const asrSec = (Number.isFinite(rawSec) && rawSec >= 0 && rawSec <= 6 * 3600)
          ? rawSec : (durSec ?? 0);
        await debit(env.USAGE, scope, asrCostUY(asrSec), "asr", { asr_sec: Math.round(asrSec), stem }, Date.now());
      }
    } catch (_) {}

    if (!transcript) {
      // 没听出语音：如果这条录音带了照片（场景照片，或「只拍照不说话」的录音），就看图
      // 写一条极简图文，而不是直接判「无语音」。只有连照片都没有，或看图也写不出内容，
      // 才落回原来的 .empty(no-speech)。
      const photos = await gatherPhotos(audioKey, allKeys, env, log);
      if (photos.length) {
        log("无语音但有照片,改走看图模式", { count: photos.length, pipeline: !!modelCfg.imagePipeline });
        await notifyStatus(scope, stem, "mining", env);
        // 和正常语音挖矿一样：文风文本进 prompt，articles[i].style 打 head 版本号
        //（不打的话 iOS chip 显示「选风格」，看起来像没用文风）。
        const imgStyleDoc = await readStyleDoc(env, scope);
        const styleText = (imgStyleDoc ? resolveStyle(imgStyleDoc) : await readStyleText(env, scope)).trim();
        const imgHeadV = imgStyleDoc && Number.isInteger(imgStyleDoc.head) ? imgStyleDoc.head : null;
        const turnId = `${Date.now()}-${stem.slice(-8)}`;

        // 流水线（modelCfg.imagePipeline，缺省关）：观察→立意→写作→审稿。
        // 任何失败回退下方现行单发 —— 质量下限就是今天的行为。
        let arts = [], pipe = null;
        if (modelCfg.imagePipeline) {
          try {
            pipe = await mineImageOnly(env, { scope, stem, photos, styleText, modelCfg, turnId, log });
            arts = pipe.articles;
            if (pipe.lowQuality) log("流水线质量门未过,交付较高一版", { overall: pipe.quality && pipe.quality.overall });
          } catch (e) {
            pipe = null;
            log("流水线失败,回退单发", { error: String((e && e.message) || e).slice(0, 200) });
          }
        }
        if (!arts.length) {
          pipe = null;
          arts = await mineVariant(env, {
            transcript: "", styleText, photos, cacheMode: "system", modelCfg, scope, stem, turnId,
            systemOverride: IMAGE_ONLY_SYSTEM, noForce: true, photoInstr: "",
            metaExtra: { source: "image" }, log,
          });
        }
        if (arts.length) {
          const pendingTags = await consumePendingTags(audioKey, env);
          // 看图模式不追问（没有口述可回答），但统一过 extractFollowups 摘掉字段，
          // 防止 questions 混进版本内容。
          const { articles: imgCleaned } = extractFollowups(arts);
          const doc = {
            schema: 2, id: stem, sourceAudio: leaf,
            createdAt: uploaded[audioKey] || new Date().toISOString(),
            transcript: "", srt: "",
            articles: imgHeadV ? imgCleaned.map((a) => ({ ...a, style: imgHeadV })) : imgCleaned,
            status: "ready", model: modelCfg.model,
            ...(pendingTags.length ? { tags: pendingTags } : {}),
            ...(pipe ? { vision: pipe.vision, plan: pipe.plan, quality: pipe.quality } : {}),
          };
          await writeArticle(audioKey, doc, env);
          await notifyStatus(scope, stem, "ready", env);
          try { await maybeAutoShareCommunity(audioKey, env, log); } catch (e) { log("自动分享失败", { error: String(e) }); }
          log("看图写入完成", { articles: arts.length, pipeline: !!pipe });
          result = "mined";
          return "mined";
        }
        log("看图也没写出内容,回退无语音");
      }
      await writeEmpty(audioKey, "no-speech", env);
      await notifyStatus(scope, stem, "empty", env);
      log("ASR 无语音");
      result = "empty";
      return "empty";
    }
    if (transcript.trim().length < MIN_CHARS) {
      await writeEmpty(audioKey, "too-short", env);
      await notifyStatus(scope, stem, "empty", env);
      log("ASR 太短", { chars: transcript.trim().length });
      result = "empty";
      return "empty";
    }

    await notifyStatus(scope, stem, "mining", env);

    // ── Style(s) + photos ───────────────────────────────────────────────────────
    // 文风走 CLAUDE.json（schema-3），回退老 CLAUDE.md 的「# 我的文风」段。
    // profile.styles 非空就覆盖 head（含单选）：1 个=单篇用那个风格；≥2 个=每个风格各挖
    // 一篇；空=用 head 默认文风。每篇都作为一个标准 article version 写入（head=最后一个），
    // 且只要风格版本号已知就写 per-article `style: N` 字段（阅读页 chip 显示；不进 body——隐形注释行会让第N行编号错位）。
    // Lazy-seed the default 王建硕 style as v1 on first mine (no-op if the user
    // already has a style; skips legacy CLAUDE.md users). After this the first
    // article is tagged 风格 v1 and the user owns an editable baseline.
    await ensureStyleSeeded(env, scope);
    const styleDoc = await readStyleDoc(env, scope);
    const claudeMd  = (styleDoc ? resolveStyle(styleDoc) : await readStyleText(env, scope)).trim();
    const headV     = (styleDoc && styleDoc.head) ? styleDoc.head : null;
    const picks = (styleDoc && styleDoc.profile && Array.isArray(styleDoc.profile.styles) ? styleDoc.profile.styles : [])
      .map((v) => ({ v, style: ((styleDoc.versions || []).find((e) => e.v === v) || {}).style }))
      .filter((p) => typeof p.style === "string" && p.style.trim());
    // The style(s) to mine: picks if any (1 overrides head too), else the head style
    // (tagged with headV). No CLAUDE.json → one untagged mine with empty style.
    const toMine = picks.length ? picks : [{ v: headV, style: claudeMd }];
    // ≥2 styles mine the SAME recording (same transcript+photos) → cache those across the
    // 文风 variants (transcript mode). A single style varies the transcript across different
    // recordings, so keep 文风 in the cached system block (system mode) for cross-recording hits.
    const cacheMode = toMine.length >= 2 ? "transcript" : "system";
    if (claudeMd || picks.length) log("文风", { chars: claudeMd.length, use: picks.length ? picks.map((p) => `v${p.v}`).join(",") : (headV ? `v${headV}(head)` : "none") });

    const photos = await gatherPhotos(audioKey, allKeys, env, log);
    if (photos.length) log("照片", { count: photos.length });

    const turnId = `${Date.now()}-${stem.slice(-8)}`;

    // Mine once for one style text → articles ([] if none). Shared core with text-mine
    // and restyle (force retry + log + debit live in mineVariant; no per-path copies).
    const mineOnce = (styleText, tag) => mineVariant(env, {
      transcript, styleText, photos, cacheMode, modelCfg, scope, stem, turnId, label: tag, log,
    });

    // Build the variant(s): one per style to mine, each tagged when its version is known.
    const variants = [];
    for (const p of toMine) {
      const arts = await mineOnce(p.style, p.v ? `风格v${p.v}` : "");
      if (arts.length) variants.push(p.v ? arts.map((a) => ({ ...a, style: p.v })) : arts);
    }

    if (!variants.length) {
      await writeEmpty(audioKey, "no-article", env);
      await notifyStatus(scope, stem, "empty", env);
      log("无文章");
      result = "empty";
      return "empty";
    }

    // ── Write article(s) ─────────────────────────────────────────────────────────
    // Each variant is PUT separately → the Files API article store appends it as a new
    // version and moves head, so after the loop head = the LAST variant (newest), and
    // undo/redo walks the others. No photos array — [[photo:<key>]] markers in the body
    // are the sole source of truth for which photos appear and where.
    const pendingTags = await consumePendingTags(audioKey, env);
    const baseDoc = {
      schema: 2, id: stem, sourceAudio: leaf,
      createdAt: uploaded[audioKey] || new Date().toISOString(),
      transcript, srt, status: "ready", model: modelCfg.model,
      ...(pendingTags.length ? { tags: pendingTags } : {}),
    };
    // 每次 PUT 整体替换 doc 元数据，最后一个 variant（= head）的 questions 生效。
    for (const arts of variants) {
      const { articles: cleaned, questions } = extractFollowups(arts);
      await writeArticle(audioKey, { ...baseDoc, articles: cleaned, ...(questions.length ? { questions } : {}) }, env);
    }
    if (srt) await writeSrt(audioKey, srt, env);
    await notifyStatus(scope, stem, "ready", env);
    try { await maybeAutoShareCommunity(audioKey, env, log); } catch (e) { log("自动分享失败", { error: String(e) }); }
    log("写入完成", { variants: variants.length });
    result = "mined";
    return "mined";

  } finally {
    // "skip" = already processed; "pending" = ASR still running (would spam a log
    // every resume pass). Only log terminal outcomes (mined / empty / error).
    if (result !== "skip" && result !== "pending") {
      await writeMineLog(env, { ts: t0, stem, audioKey, result, elapsed_ms: Date.now() - t0, events });
    }
  }
}

// ── Per-text pipeline (shared 挖文章 text/links — no ASR) ───────────────────────

async function mineOneText(textKey, uploaded, env, modelCfg) {
  const leaf  = textKey.split("/").pop();
  const scope = userPrefix(textKey);
  const stem  = stemOf(textKey);
  const t0    = Date.now();

  const events = [];
  const log = (msg, data) => {
    const entry = { ts: Date.now(), msg };
    if (data !== undefined) entry.data = data;
    events.push(entry);
    console.log(`   ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`);
  };

  let result = "error";
  try {
    if (await env.FILES.head(articleKeyFor(textKey)) || await env.FILES.head(emptyKeyFor(textKey))) {
      console.log(`   skip (already processed)`);
      return (result = "skip");
    }

    const obj  = await env.FILES.get(textKey);
    const text = obj ? (await obj.text()).trim() : "";
    if (text.length < MIN_CHARS) {
      await writeEmpty(textKey, text ? "too-short" : "empty-text", env);
      await notifyStatus(scope, stem, "empty", env);
      log("文本太短/为空", { chars: text.length });
      return (result = "empty");
    }

    await notifyStatus(scope, stem, "mining", env);

    // 文风走 CLAUDE.json（schema-3），回退老 CLAUDE.md 的「# 我的文风」段。
    const claudeMd = (await readStyleText(env, scope)).trim();
    if (claudeMd) log("文风", { chars: claudeMd.length });

    const turnId = `${Date.now()}-${stem.slice(-8)}`;

    // Same mining core as audio/restyle (force retry + log + debit in mineVariant). Text is
    // its own transcript, no photos, system-cache layout.
    const articles = await mineVariant(env, {
      transcript: text, styleText: claudeMd, photos: null, cacheMode: "system",
      modelCfg, scope, stem, turnId, metaExtra: { source: "text" }, log,
    });
    if (!articles.length) {
      await writeEmpty(textKey, "no-article", env);
      await notifyStatus(scope, stem, "empty", env);
      log("无文章 (两次均空)");
      return (result = "empty");
    }

    const { articles: cleaned, questions } = extractFollowups(articles);
    const doc = {
      schema: 2, id: stem, sourceText: leaf,
      createdAt: uploaded[textKey] || new Date().toISOString(),
      transcript: text, srt: "", articles: cleaned, status: "ready", model: modelCfg.model,
      ...(questions.length ? { questions } : {}),
    };
    await writeArticle(textKey, doc, env);
    await notifyStatus(scope, stem, "ready", env);
    try { await maybeAutoShareCommunity(textKey, env, log); } catch (e) { log("自动分享失败", { error: String(e) }); }
    log("写入完成", { articles: articles.length, titles: articles.map(a => a.title) });
    return (result = "mined");

  } finally {
    if (result !== "skip") {
      await writeMineLog(env, { ts: t0, stem, audioKey: textKey, result, elapsed_ms: Date.now() - t0, events });
    }
  }
}

// ── Per-style pipeline (训练风格 corpus collection — no article mining) ──────────
// One JSON sample per submission under `<scope>style/`; its existence is also the
// processed marker. The corpus is what a later distill step (or the
// wjs-distilling-style skill) reads to tune the user's writing-voice card.
// Text/links are captured verbatim; .docx / images are recorded but their text
// extraction is deferred (needsExtraction:true).
async function collectStyle(styleKey, uploaded, env) {
  const scope     = userPrefix(styleKey);
  const stem      = stemOf(styleKey);
  const sampleKey = styleSampleKeyFor(styleKey);
  if (await env.FILES.head(sampleKey)) return "skip";

  const leaf = styleKey.split("/").pop();
  const ext  = (leaf.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const isText = ext === "txt" || ext === "md" || ext === "url";

  let text = null, needsExtraction = false;
  if (isText) {
    const obj = await env.FILES.get(styleKey);
    text = obj ? (await obj.text()).trim() : "";
  } else {
    needsExtraction = true;   // .docx / .doc / image — kept as-is, extract later
  }

  const sample = {
    stem, sourceFile: leaf, type: ext, needsExtraction,
    collectedAt: uploaded[styleKey] || new Date().toISOString(), text,
  };
  await env.FILES.put(sampleKey, JSON.stringify(sample), { httpMetadata: { contentType: "application/json" } });
  await notifyStatus(scope, stem, "style", env);
  console.log(`   style 收录 ${leaf}${needsExtraction ? " (待提取文本)" : ` (${(text||"").length} 字)`}`);
  return "style";
}

// ── Main loop ──────────────────────────────────────────────────────────────────

export async function runMine(env) {
  const t0 = Date.now();
  const modelCfg = await loadModelConfig(env);
  console.log(`[mine] model: ${modelCfg.provider}/${modelCfg.model}`);

  // Guard: the admin selected a provider whose API key secret isn't configured.
  // Without this, every call would go out with an empty Bearer token, 401, and the
  // recording would stay 待处理 forever — retried every run, with no surfaced cause.
  // Abort loudly instead; recordings are untouched and process once the secret is set.
  if (!modelCfg.apiKey) {
    const envName = PROVIDER_ENV_KEY[modelCfg.providerKey] || "CLAUDE_API_KEY";
    console.error(`[mine] ABORT: 供应商 "${modelCfg.providerKey}" 已选中，但 Worker Secret ${envName} 未配置（API key 为空）— 跳过本次挖文，录音保持待处理`);
    return;
  }

  // Paginated list of all R2 objects
  let cursor, allObjects = [];
  do {
    const listed = await env.FILES.list({ limit: 1000, cursor });
    allObjects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  const allKeys  = allObjects.map(o => o.key);
  const uploaded = Object.fromEntries(allObjects.map(o => [o.key, o.uploaded?.toISOString?.() || ""]));
  const keySet   = new Set(allKeys);

  const audios = allKeys.filter(k => classifyKey(k) === "audio");
  const todo   = audios.filter(a => minableViaAdminApi(a) && !keySet.has(articleKeyFor(a)) && !keySet.has(emptyKeyFor(a)));
  const texts  = allKeys.filter(k => classifyKey(k) === "mine-text")
                        .filter(t => minableViaAdminApi(t) && !keySet.has(articleKeyFor(t)) && !keySet.has(emptyKeyFor(t)));
  const styles = allKeys.filter(k => classifyKey(k) === "style")
                        .filter(s => !keySet.has(styleSampleKeyFor(s)));
  // Tagged placeholder jobs (e.g. 提取文章风格): a Task<Type> .m4a, processed like audio but
  // dispatched by mineOneAudio→runTask. Marker keys (articles/<stem>.json|.empty) gate reruns.
  const tasks  = allKeys.filter(k => classifyKey(k) === "task")
                        .filter(a => minableViaAdminApi(a) && !keySet.has(articleKeyFor(a)) && !keySet.has(emptyKeyFor(a)));
  const skipped = audios.filter(a => !minableViaAdminApi(a) && !keySet.has(articleKeyFor(a)) && !keySet.has(emptyKeyFor(a))).length;
  if (skipped) console.log(`[mine] SKIPPED ${skipped} subfolder recordings (e.g. Android upload/) — admin article API can't write their stem yet`);

  console.log(`[mine] list: ${audios.length} audio · ${texts.length} text · ${styles.length} style · ${tasks.length} task · ${todo.length + texts.length + styles.length + tasks.length} unprocessed (${((Date.now()-t0)/1000).toFixed(1)}s)`);

  let mined = 0, empty = 0, styled = 0, pending = 0, failed = 0;
  // Subrequest budget: stop spending before hitting the per-invocation cap and
  // resume next pass (the Miner alarm reschedules while moreWork is true). Each
  // outcome costs roughly its fetch count; defer the rest by breaking out.
  let budget = MINE_SUBREQ_BUDGET, truncated = false;

  for (let i = 0; i < todo.length; i++) {
    if (budget <= 0) { truncated = true; console.log(`[mine] subrequest 预算用尽,剩 ${todo.length - i} 条音频留待下趟`); break; }
    console.log(`[mine] ── ${todo[i].split("/").pop()} (audio ${i+1}/${todo.length})`);
    try {
      const r = await mineOneAudio(todo[i], allKeys, uploaded, env, modelCfg);
      if (r === "mined") { mined++; budget -= 8; }
      else if (r === "empty") { empty++; budget -= 4; }
      else if (r === "pending") { pending++; budget -= ASR_POLLS_PER_PASS + 2; }
      else budget -= 2;
    } catch (e) {
      failed++; budget -= ASR_POLLS_PER_PASS + 2;
      console.error(`[mine] FAILED ${todo[i]}: ${e.message || e}`);
    }
  }

  for (let i = 0; i < tasks.length; i++) {
    if (budget <= 0) { truncated = true; console.log(`[mine] subrequest 预算用尽,剩 ${tasks.length - i} 条任务留待下趟`); break; }
    console.log(`[mine] ── ${tasks[i].split("/").pop()} (task ${i+1}/${tasks.length})`);
    try {
      const r = await mineOneAudio(tasks[i], allKeys, uploaded, env, modelCfg);
      if (r === "mined") { mined++; budget -= 8; }
      else if (r === "empty") { empty++; budget -= 4; }
      else budget -= 2;
    } catch (e) {
      failed++; budget -= 4;
      console.error(`[mine] FAILED ${tasks[i]}: ${e.message || e}`);
    }
  }

  for (let i = 0; i < texts.length; i++) {
    if (budget <= 0) { truncated = true; console.log(`[mine] subrequest 预算用尽,剩 ${texts.length - i} 条文本留待下趟`); break; }
    console.log(`[mine] ── ${texts[i].split("/").pop()} (text ${i+1}/${texts.length})`);
    try {
      const r = await mineOneText(texts[i], uploaded, env, modelCfg);
      if (r === "mined") { mined++; budget -= 8; }
      else if (r === "empty") { empty++; budget -= 4; }
      else budget -= 2;
    } catch (e) {
      failed++; budget -= 4;
      console.error(`[mine] FAILED ${texts[i]}: ${e.message || e}`);
    }
  }

  for (let i = 0; i < styles.length; i++) {
    if (budget <= 0) { truncated = true; console.log(`[mine] subrequest 预算用尽,剩 ${styles.length - i} 条风格留待下趟`); break; }
    console.log(`[mine] ── ${styles[i].split("/").pop()} (style ${i+1}/${styles.length})`);
    try {
      if (await collectStyle(styles[i], uploaded, env) === "style") styled++;
      budget -= 2;
    } catch (e) {
      console.error(`[mine] FAILED style ${styles[i]}: ${e.message || e}`);
    }
  }

  // Resume soon if ASR is still cooking or we deferred work — but NOT merely on a
  // failure (could be persistent → fast infinite loop). Failures wait for the cron.
  const moreWork = pending > 0 || truncated;
  const elapsed = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`[mine] DONE: ${mined} mined · ${empty} empty · ${pending} pending · ${styled} style · ${failed} failed · ${elapsed}s · moreWork=${moreWork}`);
  return { mined, empty, pending, styled, failed, truncated, moreWork };
}
