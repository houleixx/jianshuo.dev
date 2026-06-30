// 确定性、零模型成本的产出健康检查。挡住明显坏的（JSON 已由调用方解析），
// 不做质量判断（质量交给 LLM 裁判）。moderateArticles 是 LLM 调用，不在此处。
const MIN_BODY_CHARS = 10;

export function runProxyChecks(articles, { transcript } = {}) {
  const arr = Array.isArray(articles) ? articles : [];
  const checks = [];
  const add = (name, pass, detail = "") => checks.push({ name, pass, detail });

  add("articleCount", arr.length > 0, `articles=${arr.length}`);
  add("titlePresent", arr.length > 0 && arr.every(a => (a.title || "").trim().length > 0), "每篇都要有非空标题");
  add("bodyNonEmpty", arr.length > 0 && arr.every(a => (a.body || "").trim().length > 0), "每篇正文非空");
  const tooShort = arr.filter(a => (a.body || "").trim().length < MIN_BODY_CHARS);
  add("bodyLengthSane", tooShort.length === 0, tooShort.length ? `${tooShort.length} 篇正文 <${MIN_BODY_CHARS} 字` : "");

  return { pass: checks.every(c => c.pass), checks };
}
