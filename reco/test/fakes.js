// 内存版 D1,只实现 store.js 用到的 4 条语句。行 = {share_id,user_sub,action,created_at}。
export function fakeD1(seed = []) {
  const rows = [...seed];
  function stmt(sql) {
    let args = [];
    return {
      bind(...a) { args = a; return this; },
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
  return { DB: { prepare: (sql) => stmt(sql), _rows: rows } };
}
