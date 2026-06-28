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

import { writeLlmLog } from "./llmlog.js";
import { gateDecision, claudeCostUY, asrCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";
import { hmacSign } from "../../functions/lib/auth.js";

export const MINE_MODEL_DEFAULT = "claude-sonnet-4-6";
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
      };
    }
  } catch (_) {}
  return { providerKey: "anthropic", provider: "anthropic", model: MINE_MODEL_DEFAULT, baseUrl: "", apiKey: env.CLAUDE_API_KEY || "" };
}

// Voice editing runs an Anthropic tool-use loop (Claude only). It's a quick,
// mechanical rewrite where latency matters far more than raw quality, so it uses
// a FAST model (Haiku) by default — deliberately decoupled from the mining model
// (which is quality-critical). An explicit Claude `editModel` in config/model.json
// overrides; the mining provider/model is irrelevant to editing.
export const EDIT_MODEL_DEFAULT = "claude-haiku-4-5";

export function resolveEditModel(modelCfg) {
  const m = modelCfg && modelCfg.editModel;
  return (typeof m === "string" && m.startsWith("claude-")) ? m : EDIT_MODEL_DEFAULT;
}

// ── System prompts (identical to mine.py) ─────────────────────────────────────

const _PHOTO_INSTR = `
另外附上了几张照片，每张都标了它的 key 和拍摄时刻。照片是作者一边说一边拍的，拍摄时刻能帮你判断这张照片对应口述里的哪一段。要求：
- 把照片的场景自然融进叙述，就像亲眼看到一样直接写进去，不要机械地写「照片里是…」。
- 在正文里、口述提到这个场景的那个位置，单独起一行插入照片标记 \`[[photo:<key>]]\`（<key> 原样填我给你的那张照片的 key）。标记必须独占一行，前后空行。
- 每张照片在全文里只插入一次，按拍摄时刻对应到合适的段落附近。
- 如果某张照片实在和口述对不上，就放在最相关的那段后面。`;

const SYSTEM = `你是这段录音的录制者，在写自己的公众号文章。下面给你一段你自己的口述录音转写。把它挖成一篇或多篇可以各自独立发布的公众号文章。

拆分规则（重要）：
- 默认尽量合并。只有当转写里明显包含几个互不相关的主题时，才拆成多篇。
- 倾向「少而厚」：宁可一篇讲透，也不要拆成几篇互相重复的碎片。
- 一段口述大多只产出 1 篇；只有真的跳了好几个不相干的话题，才产出 2–3 篇。
- 每一篇都必须能独立成立：有自己的标题、自己的开头结尾，不依赖其它篇。

每一篇都遵守的语气 DNA：
- 胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
- 不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
- 第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
- 多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
- 细节能列就用表格 / 列表，不在叙述句里堆细节。
- 保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
- 不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。
- 篇幅完全顺着内容走：转写里有多少东西就写多少，长就长、短就短，三五句话也能成篇——绝不为凑字数注水或编造，也不设字数下限或上限。中英文之间留一个空格（盘古之白）。
- 只用转写里出现的事实，绝不编造。不提任何公司具体名字，需要时用「我们公司」。

只输出一个 JSON 对象：{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}，不要输出任何其它文字。只要转写里有哪怕一两句有意义的话，就要成文（可以很短）；只有完全没有可写内容时（纯噪音、半句没说完、纯口误）才输出 {"articles": []}。`;

const _FORCE_SUFFIX = `

---

【成文底线 — 优先级高于以上所有风格要求】
以上是「怎么写」的风格指南。不管内容是否完全符合上述风格，只要转写里有人在说话，就必须产出至少一篇文章。「内容不够精彩」「风格要求难以达到」均不是返回空数组的理由。短则短写，口语则口语，两三句也能成篇。`;

const SYSTEM_FORCE = `把下面的口述转写整理成一篇短文，保留说话人的意思和语气。直接输出 JSON：{"articles": [{"title": "标题", "body": "正文"}]}。只要有人在说话就必须成文，不能返回空数组。`;

const ARTICLES_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
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

// Route a freshly-listed R2 key to a pipeline. The app's Share Extension tags
// shared items with a filename prefix (VoiceDrop-mine-* / VoiceDrop-style-*);
// in-app recordings keep their plain VoiceDrop-<date>-… name and mine as audio.
//   "audio"     → ASR → articles (in-app recordings + shared .m4a for 挖文章)
//   "mine-text" → shared text/links for 挖文章; skip ASR, the text IS the transcript
//   "style"     → shared text/word/links for 训练风格; collected into the corpus
//   null        → not ours, an output/marker, or a type we don't mine yet
//                 (shared images for 挖文章 and .docx text extraction are deferred)
export function classifyKey(key) {
  if (key.includes("/articles/") || key.includes("/style/")) return null;
  const leaf = key.split("/").pop();
  if (!leaf.startsWith("VoiceDrop-")) return null;
  const ext = (leaf.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  if (leaf.startsWith("VoiceDrop-style-")) return "style";
  if (leaf.startsWith("VoiceDrop-mine-") && (ext === "txt" || ext === "md")) return "mine-text";
  if (ext === "m4a") return "audio";
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
  if (code !== "20000000") throw new AsrError(code || `submit-http-${resp.status}`);
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
    try { res = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new AsrError(`bad-json:${code || resp.status}`); }
    if (code === "20000000" || res.audio_info?.duration || res.result?.text?.trim()) return { status: "done", data: res };
    if (code && code !== "20000001" && code !== "20000002") throw new AsrError(code);
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

function parseArticles(text) {
  let t = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j > i) t = t.slice(i, j + 1);
  const obj  = JSON.parse(t);
  const arts = Array.isArray(obj) ? obj : (obj.articles || []);
  return arts
    .filter(a => typeof a === "object" && (a.body || "").trim())
    .map(a => ({ title: (a.title || "(无题)").trim(), body: (a.body || "").trim() }));
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

// ── Claude (article generation) ───────────────────────────────────────────────

async function generateArticles(transcript, claudeMd, photos, force, env, modelCfg) {
  let system;
  if (force) {
    system = SYSTEM_FORCE;
  } else if (claudeMd) {
    system = `${SYSTEM}${photos?.length ? _PHOTO_INSTR : ""}\n\n---\n\n${claudeMd}${_FORCE_SUFFIX}`;
  } else {
    system = SYSTEM + (photos?.length ? _PHOTO_INSTR : "");
  }

  const t0 = Date.now();
  let text, latencyMs, rawResp;

  if (modelCfg.provider === "openai-compat") {
    // ── OpenAI-compatible (DeepSeek / Kimi / Qwen / etc.) ────────────────────
    let userContent;
    if (!photos?.length || force) {
      userContent = `口述转写：\n\n${transcript}`;
    } else {
      userContent = [{ type: "text", text: `口述转写：\n\n${transcript}` }];
      for (let i = 0; i < photos.length; i++) {
        userContent.push({ type: "text", text: `\n[照片 key:${photos[i].relKey}，拍摄于 ${photos[i].label}]` });
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photos[i].b64}`, detail: "low" } });
      }
    }
    const payload = {
      model: modelCfg.model,
      max_tokens: force ? 2000 : 8000,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userContent },
      ],
      response_format: { type: "json_object" },
    };
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
    // ── Anthropic ─────────────────────────────────────────────────────────────
    let content;
    if (!photos?.length || force) {
      content = `口述转写：\n\n${transcript}`;
    } else {
      content = [{ type: "text", text: `口述转写：\n\n${transcript}` }];
      for (let i = 0; i < photos.length; i++) {
        content.push({ type: "text", text: `\n[照片 key:${photos[i].relKey}，拍摄于 ${photos[i].label}]` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photos[i].b64 } });
      }
    }
    const payload = {
      model: modelCfg.model, max_tokens: force ? 2000 : 8000, system,
      messages: [{ role: "user", content }],
    };
    if (!force) payload.output_config = { format: { type: "json_schema", schema: ARTICLES_SCHEMA } };
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": modelCfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    latencyMs = Date.now() - t0;
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    rawResp = await resp.json();
    text = (rawResp.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }

  return { articles: parseArticles(text), latencyMs, rawResp };
}

// ── Content moderation (Apple App Store 1.2 — filter objectionable UGC) ────────
// Judged ONCE here at generation time and stamped onto the article doc as
// `moderation:{flagged,categories,at}`. The community-share route only READS this
// flag (no second LLM call) and refuses to publish a flagged article. Anthropic
// (haiku) regardless of the mining provider, so moderation stays reliable + cheap.
// Fail-open on any infra error (don't block legit content) — report/block still cover it.
const MOD_CATEGORIES = "色情或露骨性内容、暴力血腥、仇恨或歧视、骚扰或欺凌、违法内容(毒品/武器/诈骗等)、自残或自杀、未成年人不当内容";
export async function moderateArticles(articles, env) {
  if (!env.CLAUDE_API_KEY) return { flagged: false, skipped: "no-key" };
  const text = (articles || []).map(a => `${a.title || ""}\n${a.body || ""}`).join("\n\n").trim().slice(0, 16000);
  if (!text) return { flagged: false };
  const system = `你是面向公开社区的内容安全审核员。判断下面这篇用户生成的中文文章，是否含有不适合公开展示的内容（${MOD_CATEGORIES}）。正常的观点表达、商业、生活、科技、情绪宣泄一律视为安全(false)；只有明确违规才标记 true。只输出 JSON，不要解释：{"flagged":true|false,"categories":["命中的类别"]}`;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200,
        system, messages: [{ role: "user", content: text }] }),
    });
    if (!resp.ok) return { flagged: false, error: `http-${resp.status}` };
    const j = await resp.json();
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
export async function maybeAutoShareCommunity(srcKey, env, log = () => {}) {
  if (!env.SESSION_SECRET) return null;            // can't derive shareId without it
  const scope = userPrefix(srcKey);                // users/<sub>/
  const cfgObj = await env.FILES.get(scope + "CONFIG.json");
  if (!cfgObj) return null;
  let cfg; try { cfg = JSON.parse(await cfgObj.text()); } catch { return null; }
  if (cfg.autoShareCommunity !== true) return null;

  const articleKey = articleKeyFor(srcKey);        // users/<sub>/articles/<stem>.json
  // author — same source/regex as the share endpoint (CLAUDE.md「# 我的名字」), else 匿名.
  let author = "匿名";
  const md = await env.FILES.get(scope + "CLAUDE.md");
  if (md) { const m = (await md.text()).match(/#\s*我的名字\s*\n+([^\n#]+)/); if (m && m[1].trim()) author = m[1].trim(); }

  const shareId = (await hmacSign("community:" + articleKey, env.SESSION_SECRET)).slice(0, 12);
  const communityKey = `community/${shareId}.json`;
  // Preserve firstSharedAt + replyTo when re-sharing (re-mine), exactly like the endpoint.
  let firstSharedAt = Date.now();
  let replyTo = null;
  const existing = await env.FILES.get(communityKey);
  if (existing) {
    try { const ep = JSON.parse(await existing.text()); firstSharedAt = ep.firstSharedAt || firstSharedAt; replyTo = ep.replyTo || null; } catch {}
  }
  const post = { schema: 2, shareId, owner: scope, articleKey, author, firstSharedAt,
                 ...(replyTo ? { replyTo } : {}) };
  await env.FILES.put(communityKey, JSON.stringify(post), { httpMetadata: { contentType: "application/json" } });
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

async function mineOneAudio(audioKey, allKeys, uploaded, env, modelCfg) {
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

    // ── Balance gate (pre-ASR) ────────────────────────────────────────────────
    const durSec = audioDurationSeconds(audioKey);
    const decision = await meteredMineGate(env.USAGE, scope, durSec ?? 0, Date.now());
    if (decision === "too-long") { await writeBlocked(audioKey, "too-long", env); return; }
    if (decision === "no-credit") { await writeBlocked(audioKey, "no-credit", env); return; }
    // Drop stale .blocked marker before proceeding (e.g. user topped up)
    try { await env.FILES.delete(`${userPrefix(audioKey)}articles/${stemOf(audioKey)}.blocked`); } catch (_) {}

    await notifyStatus(scope, stem, "asr", env);

    // ── ASR (resumable across passes) ───────────────────────────────────────────
    let transcript, srt, asrDurMs;
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

    // ── Style card + photos ───────────────────────────────────────────────────
    const claudeMdObj = await env.FILES.get(scope + "CLAUDE.md");
    const claudeMd    = claudeMdObj ? (await claudeMdObj.text()).trim() : "";
    if (claudeMd) log("CLAUDE.md", { chars: claudeMd.length });

    const photoKeys = findSessionPhotos(audioKey, allKeys);
    const photos    = [];
    for (const pk of photoKeys) {
      try { const p = await loadPhoto(pk, env); if (p) photos.push(p); }
      catch (e) { log("照片加载失败", { key: pk, err: e.message }); }
    }
    if (photos.length) log("照片", { count: photos.length });

    // ── LLM (first pass, then force retry) ────────────────────────────────────
    const turnId = `${Date.now()}-${stem.slice(-8)}`;
    const meta   = { user_scope: scope, stem };
    let articles;

    const runLlm = async (force, step) => {
      const tLlm = Date.now();
      log(`LLM 开始${force ? " (force)" : ""}`, { step });
      try {
        const r = await generateArticles(transcript, force ? "" : claudeMd, force ? null : (photos.length ? photos : null), force, env, modelCfg);
        await writeLlmLog(env, { source: "mine", ok: true, status: 200, model: modelCfg.model, latency_ms: r.latencyMs, step, turn_id: turnId, meta, response: r.rawResp });
        // Debit Claude cost (best-effort)
        try {
          if (env.USAGE) {
            const u = r.rawResp?.usage || {};
            await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, u.input_tokens, u.output_tokens),
              "mine", { model: modelCfg.model, in_tok: u.input_tokens, out_tok: u.output_tokens, stem, turn_id: turnId }, Date.now());
          }
        } catch (_) {}
        log(`LLM 完成${force ? " (force)" : ""}`, { articles: r.articles.length, latency_ms: r.latencyMs });
        return r.articles;
      } catch (e) {
        await writeLlmLog(env, { source: "mine", ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now()-tLlm, step, turn_id: turnId, meta, error: String(e) });
        throw e;
      }
    };

    articles = await runLlm(false, 0);

    if (!articles.length) {
      log("LLM 无文章，重试 (force)");
      try { articles = await runLlm(true, 1); } catch (_) { articles = []; }
      if (!articles.length) {
        await writeEmpty(audioKey, "no-article", env);
        await notifyStatus(scope, stem, "empty", env);
        log("无文章 (两次均空)");
        result = "empty";
        return "empty";
      }
    }

    // ── Write article ──────────────────────────────────────────────────────────
    // No photos array — the model inserts [[photo:<key>]] markers into the body,
    // which is the sole source of truth for which photos appear and where.
    // Content moderation (judged once, here): flagged articles can't be shared to 社区.
    let moderation = null;
    try { moderation = await moderateArticles(articles, env); if (moderation?.flagged) log("内容审核命中(不可分享社区)", { categories: moderation.categories }); }
    catch (e) { log("内容审核出错(放行)", { error: String(e?.message ?? e).slice(0,120) }); }

    const doc = {
      schema: 2, id: stem, sourceAudio: leaf,
      createdAt: uploaded[audioKey] || new Date().toISOString(),
      transcript, srt, articles, status: "ready", model: modelCfg.model,
      ...(moderation ? { moderation } : {}),
    };

    await writeArticle(audioKey, doc, env);
    if (srt) await writeSrt(audioKey, srt, env);
    await notifyStatus(scope, stem, "ready", env);
    try { await maybeAutoShareCommunity(audioKey, env, log); } catch (e) { log("自动分享失败", { error: String(e) }); }
    log("写入完成", { articles: articles.length, titles: articles.map(a => a.title) });
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

    const claudeMdObj = await env.FILES.get(scope + "CLAUDE.md");
    const claudeMd    = claudeMdObj ? (await claudeMdObj.text()).trim() : "";
    if (claudeMd) log("CLAUDE.md", { chars: claudeMd.length });

    const turnId = `${Date.now()}-${stem.slice(-8)}`;
    const meta   = { user_scope: scope, stem, source: "text" };

    const runLlm = async (force, step) => {
      const tLlm = Date.now();
      log(`LLM 开始${force ? " (force)" : ""}`, { step });
      try {
        const r = await generateArticles(text, force ? "" : claudeMd, null, force, env, modelCfg);
        await writeLlmLog(env, { source: "mine", ok: true, status: 200, model: modelCfg.model, latency_ms: r.latencyMs, step, turn_id: turnId, meta, response: r.rawResp });
        // Debit Claude cost (best-effort)
        try {
          if (env.USAGE) {
            const u = r.rawResp?.usage || {};
            await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, u.input_tokens, u.output_tokens),
              "mine", { model: modelCfg.model, in_tok: u.input_tokens, out_tok: u.output_tokens, stem, turn_id: turnId }, Date.now());
          }
        } catch (_) {}
        log(`LLM 完成${force ? " (force)" : ""}`, { articles: r.articles.length, latency_ms: r.latencyMs });
        return r.articles;
      } catch (e) {
        await writeLlmLog(env, { source: "mine", ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now()-tLlm, step, turn_id: turnId, meta, error: String(e) });
        throw e;
      }
    };

    let articles = await runLlm(false, 0);
    if (!articles.length) {
      log("LLM 无文章，重试 (force)");
      try { articles = await runLlm(true, 1); } catch (_) { articles = []; }
      if (!articles.length) {
        await writeEmpty(textKey, "no-article", env);
        await notifyStatus(scope, stem, "empty", env);
        log("无文章 (两次均空)");
        return (result = "empty");
      }
    }

    let moderation = null;
    try { moderation = await moderateArticles(articles, env); if (moderation?.flagged) log("内容审核命中(不可分享社区)", { categories: moderation.categories }); }
    catch (e) { log("内容审核出错(放行)", { error: String(e?.message ?? e).slice(0,120) }); }

    const doc = {
      schema: 2, id: stem, sourceText: leaf,
      createdAt: uploaded[textKey] || new Date().toISOString(),
      transcript: text, srt: "", articles, status: "ready", model: modelCfg.model,
      ...(moderation ? { moderation } : {}),
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
  const todo   = audios.filter(a => !keySet.has(articleKeyFor(a)) && !keySet.has(emptyKeyFor(a)));
  const texts  = allKeys.filter(k => classifyKey(k) === "mine-text")
                        .filter(t => !keySet.has(articleKeyFor(t)) && !keySet.has(emptyKeyFor(t)));
  const styles = allKeys.filter(k => classifyKey(k) === "style")
                        .filter(s => !keySet.has(styleSampleKeyFor(s)));

  console.log(`[mine] list: ${audios.length} audio · ${texts.length} text · ${styles.length} style · ${todo.length + texts.length + styles.length} unprocessed (${((Date.now()-t0)/1000).toFixed(1)}s)`);

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
