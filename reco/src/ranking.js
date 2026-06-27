// 互动加权(起步值,= recommendation_system.md §3.1)。
// report 是负权重:一个举报 = 3 个负的点赞(= -3 × like = -9),既能把冷启动帖压到
// 负分沉底,又不会让一两个举报就抹掉一篇真有互动的热帖(防单点举报滥用)。
export const W = { view: 1, finish: 4, like: 3, reply: 5, report: -9 };

// HN/牛顿冷却:新帖起高分,随时间冷却。firstSharedAt 是 ms。
export function postScore(eng, replyCount, firstSharedAt, now) {
  const e = W.view * (eng.view || 0) + W.finish * (eng.finish || 0)
          + W.like * (eng.like || 0) + W.reply * (replyCount || 0)
          + W.report * (eng.report || 0);
  const ageHours = Math.max(0, (now - (firstSharedAt || now)) / 3600000);
  return (1 + e) / Math.pow(ageHours + 2, 1.5);
}

// 排序 + 作者打散(贪心,乘性惩罚;作者少时几乎不生效)。返回 shareId 数组。
export function rankPosts(posts, engMap, now) {
  const scored = posts.map((p) => ({
    p, s: postScore(engMap[p.shareId] || {}, p.replyCount, p.firstSharedAt, now),
  }));
  const out = [], seen = {};
  while (scored.length) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < scored.length; i++) {
      const adj = scored[i].s * Math.pow(0.5, seen[scored[i].p.author] || 0);
      if (adj > bv) { bv = adj; bi = i; }
    }
    const [picked] = scored.splice(bi, 1);
    seen[picked.p.author] = (seen[picked.p.author] || 0) + 1;
    out.push(picked.p.shareId);
  }
  return out;
}
