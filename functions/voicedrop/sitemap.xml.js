// functions/voicedrop/sitemap.xml.js — voicedrop.cn 的 sitemap（动态）。
//
// 路由：voicedrop.cn/sitemap.xml → EdgeOne 补前缀 → CF Pages /voicedrop/sitemap.xml。
// 命名 Function 优先级高于 [token].js 动态路由，所以这里能截住而不被当成分享 id。
//
// 内容 = 固定营销页 + 所有公开社区帖（RECO_DB.community_posts, hidden=0）。
// 社区帖是 voicedrop.cn/<shareId> 的公开文章，索引它们 = 让分享内容被搜到（自然流量）。
// D1 不可用时仍返回固定页，绝不整张 sitemap 失败。

const ORIGIN = "https://voicedrop.cn";

// 稳定的公开页（存在且值得索引的；admin/agent/api 不列）。
const STATIC_PAGES = [
  { loc: "/", priority: "1.0", changefreq: "daily" },
  { loc: "/community/", priority: "0.9", changefreq: "daily" },
  { loc: "/help/", priority: "0.5", changefreq: "monthly" },
  { loc: "/welcome/", priority: "0.6", changefreq: "monthly" },
  { loc: "/privacy/", priority: "0.3", changefreq: "yearly" },
  { loc: "/apk/", priority: "0.6", changefreq: "monthly" },
  { loc: "/en/", priority: "0.6", changefreq: "weekly" },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ymd = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try { return new Date(n).toISOString().slice(0, 10); } catch { return null; }
};

export async function onRequest(context) {
  const { env } = context;
  const urls = [];

  for (const p of STATIC_PAGES) {
    urls.push(`  <url>\n    <loc>${ORIGIN}${p.loc}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`);
  }

  // 公开社区帖（best-effort：D1 报错就只留固定页）。
  try {
    if (env.RECO_DB) {
      const r = await env.RECO_DB.prepare(
        "SELECT share_id, updated_at, first_shared_at FROM community_posts WHERE hidden=0 ORDER BY first_shared_at DESC LIMIT 5000"
      ).all();
      for (const row of r.results || []) {
        if (!row.share_id) continue;
        const lm = ymd(row.updated_at || row.first_shared_at);
        urls.push(
          `  <url>\n    <loc>${ORIGIN}/${esc(row.share_id)}</loc>` +
          (lm ? `\n    <lastmod>${lm}</lastmod>` : "") +
          `\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`
        );
      }
    }
  } catch (e) {
    console.log("[sitemap] community query failed:", e && e.message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // 边缘缓存 1 小时：内容随社区帖增长，但不需要实时。
      "cache-control": "public, max-age=3600",
    },
  });
}
