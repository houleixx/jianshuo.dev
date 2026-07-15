// Community share-gate keyword filter (Apple App Store 1.2 — a method for filtering
// objectionable material BEFORE it's posted). Zero-cost and zero-LLM: it runs only
// when a user actually shares to the public community, never on every generated
// article. Deliberately conservative — it targets unambiguous objectionable terms
// so legitimate opinion / business / life writing is never blocked; the report +
// block + EULA pillars catch whatever slips through.
//
// Matching: CJK terms match as substrings (no word boundaries in Chinese); ASCII
// terms match on word boundaries to avoid the Scunthorpe problem. The blocklist can
// be tuned WITHOUT a deploy by writing a JSON array to R2 `config/community-blocklist.json`
// (merged with the built-in list).

// Built-in unambiguous objectionable terms (sexual-explicit / illegal / incitement).
// Kept intentionally specific (multi-char phrases) to minimise false positives.
const DEFAULT_TERMS = [
  // 露骨性内容
  "性交", "做爱", "肏", "鸡巴", "阴茎", "阴道", "自慰", "口交", "群交", "乱伦",
  "卖淫", "嫖娼", "招嫖", "约炮", "裸聊", "援交", "性服务", "成人影片", "色情片",
  // 性暴力
  "强奸", "轮奸", "迷奸", "强暴",
  // 暴力 / 仇恨煽动
  "杀光", "砍死你", "弄死你", "捅死你", "我要杀", "炸死",
  // 违法交易
  "冰毒", "海洛因", "摇头丸", "贩毒", "枪支买卖", "买卖枪支", "制造炸弹", "制作炸药",
  "办假证", "代开发票", "出售身份证", "网络赌博", "代孕中介",
  // ASCII (word-boundary)
  "fuck", "cunt", "rape", "porn", "heroin", "child porn", "cp交易",
];

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s​　]+/g, "");   // strip whitespace/zero-width to dodge "性 交"
}

const ASCII_RE = /^[\x00-\x7f]+$/;

/**
 * Scan text for objectionable terms. Returns { flagged:boolean, term?:string }.
 * CJK terms: substring on whitespace-stripped text. ASCII terms: word-boundary on
 * the original text (so "rape" doesn't hit "grape").
 */
export function scanObjectionable(text, extraTerms = []) {
  const raw = String(text || "");
  const flat = normalize(raw);
  const lowerRaw = raw.toLowerCase();
  for (const term of [...DEFAULT_TERMS, ...extraTerms]) {
    if (!term) continue;
    const t = String(term).toLowerCase();
    if (ASCII_RE.test(t)) {
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lowerRaw)) return { flagged: true, term };
    } else if (flat.includes(t.replace(/\s+/g, ""))) {
      return { flagged: true, term };
    }
  }
  return { flagged: false };
}

/**
 * R2 blocklist override（best-effort，读不到/坏 JSON = 空表，内置表照常生效）。
 * 单独导出是给想把这次读并进自己 Promise.all 的调用方（prompt-share 的开分享
 * 曾因串行读叠出 10 秒延迟）——读出的表原样传给 checkArticlesShareable 第三参。
 */
export async function loadShareBlocklist(env) {
  if (!(env && env.FILES)) return [];
  try {
    const o = await env.FILES.get("config/community-blocklist.json");
    if (o) { const a = JSON.parse(await o.text()); if (Array.isArray(a)) return a.filter(x => typeof x === "string"); }
  } catch { /* ignore — built-in list still applies */ }
  return [];
}

/**
 * Share-gate check over an article list. Concatenates titles + bodies and scans.
 * `env` (optional) lets us merge an R2 blocklist override (best-effort)；调用方
 * 已经预取过就传 `extraList`（省一次 R2 读，env 此时可省略）。
 */
export async function checkArticlesShareable(articles, env, extraList) {
  const extra = Array.isArray(extraList) ? extraList : await loadShareBlocklist(env);
  const text = (articles || []).map(a => `${a.title || ""}\n${a.body || ""}`).join("\n\n");
  return scanObjectionable(text, extra);
}
