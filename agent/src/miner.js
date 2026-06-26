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

export const MINE_MODEL_DEFAULT = "claude-sonnet-4-6";
const MIN_CHARS          = 20;
const ORIGIN             = "https://jianshuo.dev";

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

// Voice editing (ArticleEditor) runs an Anthropic tool-use loop, so it can only
// execute on Claude. Honor the admin's model choice when the configured provider
// is Anthropic (e.g. switch sonnet↔opus); for any non-Anthropic provider fall
// back to the default Claude model — the agentic edit loop can't run there.
export function resolveEditModel(modelCfg) {
  return (modelCfg && modelCfg.providerKey === "anthropic" && modelCfg.model)
    ? modelCfg.model
    : MINE_MODEL_DEFAULT;
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

function sessionTs(audioKey) {
  const leaf = audioKey.split("/").pop().replace(/\.m4a$/, "");
  const parts = leaf.split("-");
  return (parts.length >= 5 && parts[0] === "VoiceDrop") ? parts.slice(1, 5).join("-") : null;
}

function articleKeyFor(audioKey) {
  const parts = audioKey.split("/");
  const stem = parts.pop().replace(/\.m4a$/, "");
  return `${parts.join("/")}/articles/${stem}.json`;
}

function emptyKeyFor(audioKey) {
  const parts = audioKey.split("/");
  const stem = parts.pop().replace(/\.m4a$/, "");
  return `${parts.join("/")}/articles/${stem}.empty`;
}

// "users/<sub>/VoiceDrop-stem.m4a" → "<sub>/VoiceDrop-stem"  (admin article API path)
function adminArticlePath(audioKey) {
  const prefix = userPrefix(audioKey);
  const sub = prefix.startsWith("users/") ? prefix.slice(6, -1) : prefix.slice(0, -1);
  const stem = audioKey.split("/").pop().replace(/\.m4a$/, "");
  return `${sub}/${stem}`;
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

class AsrError extends Error {
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

async function asrPoll({ taskId, logId }, env, deadlineMs) {
  const hdrs = {
    "X-Api-App-Key":     env.VOLC_ASR_APPID,
    "X-Api-Access-Key":  env.VOLC_ASR_ACCESS_TOKEN,
    "X-Api-Resource-Id": "volc.bigasr.auc",
    "X-Api-Request-Id":  taskId,
    "X-Tt-Logid":        logId,
    "X-Api-Sequence":    "-1",
    "Content-Type":      "application/json",
  };
  while (Date.now() < deadlineMs) {
    const resp = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
      { method: "POST", headers: hdrs, body: JSON.stringify({ task_id: taskId }) });
    const code = resp.headers.get("X-Api-Status-Code") || "";
    const text = await resp.text();
    const res  = text.trim() ? JSON.parse(text) : {};
    if (code === "20000000" || res.audio_info?.duration || res.result?.text?.trim()) return res;
    if (code && code !== "20000001" && code !== "20000002") throw new AsrError(code);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("ASR timed out after 600s");
}

async function transcribe(audioKey, env) {
  const audioUrl = await presignR2(audioKey, env);
  const task = await asrSubmit(audioUrl, env);
  console.log(`   [asr] submitted task=${task.taskId.slice(0, 8)}…`);
  const res    = await asrPoll(task, env, Date.now() + 600_000);
  const result = res.result || {};
  const utts   = result.utterances || [];
  const text   = (result.text || "").trim() || utts.map(u => u.text || "").join("").trim();
  return { transcript: text, srt: buildSrt(utts) };
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

// ── LLM log ───────────────────────────────────────────────────────────────────

async function writeLlmLog(env, rec) {
  try {
    const ts  = Date.now();
    const rid = `${ts}-${[...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2,"0")).join("")}`;
    const day = new Date(ts).toISOString().slice(0, 10);
    await env.FILES.put(`llmlogs/${day}/${rid}.json`,
      JSON.stringify({ id: rid, ts, source: "mine", ...rec }),
      { httpMetadata: { contentType: "application/json" } });
  } catch (_) {}
}

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
  const stem  = leaf.replace(/\.m4a$/, "");
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

    await notifyStatus(scope, stem, "asr", env);

    // ── ASR ────────────────────────────────────────────────────────────────────
    let transcript, srt;
    try {
      log("ASR 提交中");
      const tAsr = Date.now();
      ({ transcript, srt } = await transcribe(audioKey, env));
      log("ASR 完成", { chars: transcript.length, duration_ms: Date.now() - tAsr });
    } catch (e) {
      if (e instanceof AsrError) {
        await writeEmpty(audioKey, `asr-error:${e.code}`, env);
        await notifyStatus(scope, stem, "empty", env);
        log("ASR 错误", { code: e.code });
        result = "empty";
        return "empty";
      }
      throw e;
    }

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
        await writeLlmLog(env, { ok: true, status: 200, model: modelCfg.model, latency_ms: r.latencyMs, step, turn_id: turnId, meta, response: r.rawResp });
        log(`LLM 完成${force ? " (force)" : ""}`, { articles: r.articles.length, latency_ms: r.latencyMs });
        return r.articles;
      } catch (e) {
        await writeLlmLog(env, { ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now()-tLlm, step, turn_id: turnId, meta, error: String(e) });
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
    const doc = {
      schema: 2, id: stem, sourceAudio: leaf,
      createdAt: uploaded[audioKey] || new Date().toISOString(),
      transcript, srt, articles, status: "ready", model: modelCfg.model,
    };

    await writeArticle(audioKey, doc, env);
    if (srt) await writeSrt(audioKey, srt, env);
    await notifyStatus(scope, stem, "ready", env);
    log("写入完成", { articles: articles.length, titles: articles.map(a => a.title) });
    result = "mined";
    return "mined";

  } finally {
    if (result !== "skip") {
      await writeMineLog(env, { ts: t0, stem, audioKey, result, elapsed_ms: Date.now() - t0, events });
    }
  }
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

  const audios = allKeys.filter(k => k.split("/").pop().startsWith("VoiceDrop-") && k.endsWith(".m4a"));
  const todo   = audios.filter(a => !keySet.has(articleKeyFor(a)) && !keySet.has(emptyKeyFor(a)));

  console.log(`[mine] list: ${audios.length} audio · ${todo.length} unprocessed (${((Date.now()-t0)/1000).toFixed(1)}s)`);

  let mined = 0, empty = 0;
  for (let i = 0; i < todo.length; i++) {
    console.log(`[mine] ── ${todo[i].split("/").pop()} (${i+1}/${todo.length})`);
    try {
      const r = await mineOneAudio(todo[i], allKeys, uploaded, env, modelCfg);
      if (r === "mined") mined++;
      else if (r === "empty") empty++;
    } catch (e) {
      console.error(`[mine] FAILED ${todo[i]}: ${e.message || e}`);
    }
  }

  const elapsed = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`[mine] DONE: ${mined} mined · ${empty} empty · ${elapsed}s total`);
}
