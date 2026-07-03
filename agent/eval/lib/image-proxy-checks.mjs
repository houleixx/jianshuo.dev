// image-only 产物的确定性回退检查（不打 LLM）：photo 标记完整性与格式。
// 语义质量（信息密度/立意/文风）交给 judge 盲评，这里只拦「结构性坏」。
export function runImageProxyChecks(articles, { photoKeys = [] } = {}) {
  const failures = [];
  const arts = Array.isArray(articles) ? articles : [];
  if (!arts.length) failures.push("no-article");
  const body = arts.map((a) => a.body || "").join("\n\n");
  const found = [...body.matchAll(/\[\[photo:([^\]]+)\]\]/g)].map((m) => m[1]);
  for (const k of photoKeys) {
    const n = found.filter((f) => f === k).length;
    if (n === 0) failures.push(`missing-photo:${k}`);
    if (n > 1) failures.push(`dup-photo:${k}`);
  }
  for (const f of found) if (!photoKeys.includes(f)) failures.push(`invented-photo:${f}`);
  for (const a of arts) {
    for (const line of (a.body || "").split("\n")) {
      const t = line.trim();
      if (t.includes("[[photo:") && !/^\[\[photo:[^\]]+\]\]$/.test(t)) { failures.push("marker-not-own-line"); break; }
    }
  }
  return { pass: failures.length === 0, failures };
}
