// 内存版 D1,实现 store.js 用到的语句。engagement 行 = {share_id,user_sub,action,created_at};
// posts = community_posts 展示索引行（feed 测试用,字段同真表列名）。
// bind 复刻真 D1 的 100 参数上限——社区过百帖时 IN (?,?,…) 整条炸掉的事故（2026-07-13）
// 必须能在单测里复现,否则 fake 比真库宽松,测试全绿线上照样 500。
export function fakeD1(seed = [], posts = []) {
  const rows = [...seed];
  function stmt(sql) {
    let args = [];
    return {
      bind(...a) {
        if (a.length > 100) throw new Error(`too many SQL variables (${a.length} > 100)`);
        args = a; return this;
      },
      async run() {
        if (/^INSERT OR IGNORE/.test(sql)) {
          const [share_id, user_sub, action, created_at] = args;
          if (!rows.some(r => r.share_id === share_id && r.user_sub === user_sub && r.action === action))
            rows.push({ share_id, user_sub, action, created_at });
        } else if (/^DELETE/.test(sql)) {
          const [share_id, user_sub] = args;
          for (let i = rows.length - 1; i >= 0; i--)
            if (rows[i].share_id === share_id && rows[i].user_sub === user_sub && rows[i].action === "like") rows.splice(i, 1);
        }
        return { success: true };
      },
      async all() {
        if (/FROM community_posts/.test(sql)) {
          // feed: WHERE hidden=0 ORDER BY first_shared_at DESC
          const results = posts
            .filter((p) => !p.hidden)
            .sort((a, b) => (b.first_shared_at || 0) - (a.first_shared_at || 0));
          return { results };
        }
        if (/GROUP BY/.test(sql)) {
          // counts: WHERE share_id IN (...) GROUP BY share_id, action
          const ids = new Set(args);
          const agg = new Map();
          for (const r of rows) {
            if (!ids.has(r.share_id)) continue;
            const k = r.share_id + " " + r.action;
            agg.set(k, (agg.get(k) || 0) + 1);
          }
          const results = [...agg.entries()].map(([k, c]) => {
            const [share_id, action] = k.split(" ");
            return { share_id, action, c };
          });
          return { results };
        }
        // liked: WHERE user_sub=? AND action='like' AND share_id IN (...)
        const sub = args[0], ids = new Set(args.slice(1));
        const results = rows
          .filter(r => r.user_sub === sub && r.action === "like" && ids.has(r.share_id))
          .map(r => ({ share_id: r.share_id }));
        return { results };
      },
    };
  }
  return { DB: { prepare: (sql) => stmt(sql), _rows: rows, _posts: posts } };
}
