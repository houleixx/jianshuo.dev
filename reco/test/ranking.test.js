import { describe, it, expect } from "vitest";
import { postScore, rankPosts } from "../src/ranking.js";

const HOUR = 3600000;

describe("postScore", () => {
  it("新帖(age≈0、零互动)得分高于老帖(零互动)", () => {
    const now = 1_000_000_000_000;
    const fresh = postScore({}, 0, now, now);
    const old = postScore({}, 0, now - 48 * HOUR, now);
    expect(fresh).toBeGreaterThan(old);
  });

  it("互动按权重计入:like 比 view 抬分更多", () => {
    const now = 1_000_000_000_000;
    const withLike = postScore({ like: 1 }, 0, now, now);
    const withView = postScore({ view: 1 }, 0, now, now);
    expect(withLike).toBeGreaterThan(withView);
  });

  it("高互动老帖能顶过零互动新帖", () => {
    const now = 1_000_000_000_000;
    const hotOld = postScore({ like: 5, finish: 5 }, 3, now - 12 * HOUR, now);
    const coldNew = postScore({}, 0, now, now);
    expect(hotOld).toBeGreaterThan(coldNew);
  });

  it("firstSharedAt 缺失不崩(当作 now)", () => {
    const now = 1_000_000_000_000;
    expect(postScore({}, 0, undefined, now)).toBeGreaterThan(0);
  });

  it("reply 权重最高:1 个 reply 抬分高于 1 个 like", () => {
    const now = 1_000_000_000_000;
    const oneReply = postScore({}, 1, now, now);
    const oneLike = postScore({ like: 1 }, 0, now, now);
    expect(oneReply).toBeGreaterThan(oneLike);
  });

  it("一个举报 ≈ 3 个负赞:把零互动新帖压到负分、沉到正常帖之下", () => {
    const now = 1_000_000_000_000;
    const reported = postScore({ report: 1 }, 0, now, now);
    const coldNew = postScore({}, 0, now, now);
    expect(reported).toBeLessThan(coldNew);
    expect(reported).toBeLessThan(0);
  });

  it("一个举报正好抵消 3 个点赞(净零等价)", () => {
    const now = 1_000_000_000_000;
    const likedThenReported = postScore({ like: 3, report: 1 }, 0, now, now);
    const neutral = postScore({}, 0, now, now);
    expect(likedThenReported).toBeCloseTo(neutral, 10);
  });
});

describe("rankPosts", () => {
  it("空输入返回空数组", () => {
    expect(rankPosts([], {}, 1)).toEqual([]);
  });

  it("同作者多帖被打散(不相邻)", () => {
    const now = 1_000_000_000_000;
    // a1,a2,a3 同作者且分本应最高;b1 不同作者。打散后 a 系列不应三连。
    const posts = [
      { shareId: "a1", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "a2", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "a3", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "b1", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const order = rankPosts(posts, {}, now);
    expect(order).toHaveLength(4);
    // B 不应被挤到最后(它在第二位被提上来)
    expect(order.indexOf("b1")).toBeLessThan(3);
  });

  it("按分排序:高互动帖排在前", () => {
    const now = 1_000_000_000_000;
    const posts = [
      { shareId: "x", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "y", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const order = rankPosts(posts, { y: { like: 10 } }, now);
    expect(order[0]).toBe("y");
  });

  it("被举报帖排到最后", () => {
    const now = 1_000_000_000_000;
    const posts = [
      { shareId: "x", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "y", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const order = rankPosts(posts, { x: { report: 1 } }, now);
    expect(order[order.length - 1]).toBe("x");
  });
});
