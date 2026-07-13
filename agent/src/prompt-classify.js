// src/prompt-classify.js — 读一条提示词，猜它该在长按【文字】还是【图片】时出现。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md §7
//
// 纯逻辑 + 注入 claude（照 style-extract.js 范式），路由层包真实调用/计费/日志。
//
// 【绝不能挡住用户新建提示词】——它只是给 5c 两个开关一个预勾选的起点。Claude 挂了、
// 算力不足、模型返回垃圾，一律回退「都行」+ 空 reason（客户端就不渲染那条琥珀提示条）。
// 所以这个函数【永不抛异常】——包括 claude 同步抛出（而非拒绝的 Promise）的情况。

export const CLASSIFY_SYSTEM = `你在给一条"提示词"判断它的适用范围。

用户在文章里长按一段【文字】或一张【图片】，会弹出菜单选一条提示词来执行。
你要判断这条提示词应该出现在哪种长按菜单里：

- "text"：作用于一段文字（改写、润色、扩写、翻译、改成某种文体…）
- "image"：作用于一张图片（重画、换风格、调色…）
- 两个都要：既能作用于文字也能作用于图片（比如"解释一下"）

注意：提示词的【产出】是什么不重要，重要的是它【作用于】什么。
比如"给这篇文章画一张题图"作用于文字（用户长按正文时用它），产出才是图 —— 它是 "text"。

只输出 JSON，不要任何别的字：
{"appliesTo":["text"],"reason":"一句话说明，20 字以内，口语"}`;

const VALID = ["text", "image"];
const FALLBACK = { appliesTo: ["text", "image"], reason: "" };
const MAX_REASON = 60;

// 从模型输出里抠 JSON：容忍 ```json 围栏和前后废话，以及模型吐出多个 {...} 片段
// 的情况——取【最外层】那个（第一个 `{` 到最后一个 `}`），而不是第一个碰到的花括号
// 对，否则 `{"a":1} garbage {"appliesTo":["text"]}` 这类输出会被前一个碎片抢先
// 命中、解析失败后整体回退，明明后半段是能用的合法 JSON。
function extractJSON(raw) {
  const s = String(raw || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export async function classifyAppliesTo(prompt, claude) {
  try {
    const raw = await claude({
      system: CLASSIFY_SYSTEM,
      messages: [{ role: "user", content: String(prompt || "").slice(0, 4000) }],
    });
    const parsed = extractJSON(raw);
    if (!parsed || !Array.isArray(parsed.appliesTo)) return { ...FALLBACK };
    // 过滤非法值 + 去重（模型偶尔会吐 ["text","text"]，去重后再判空，避免把
    // 一个其实合法的单值结果误判成噪声）。
    const appliesTo = [...new Set(parsed.appliesTo.filter((a) => VALID.includes(a)))];
    if (!appliesTo.length) return { ...FALLBACK };
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, MAX_REASON) : "";
    return { appliesTo, reason };
  } catch (e) {
    // 注意：claude 参数可能同步抛出（不只是拒绝的 Promise）——await 一个同步抛出的
    // 调用一样会被这个 try/catch 兜住，因为 `await claude(...)` 里 `claude(...)`
    // 本身的调用也在 try 块内执行。
    console.error("[prompt-classify] fell back to 都行:", e && e.message);
    return { ...FALLBACK };
  }
}
