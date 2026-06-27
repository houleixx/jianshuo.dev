import { describe, it, expect } from "vitest";
import { recordEngagement, countsFor, likedBy } from "../src/store.js";
import { fakeD1 } from "./fakes.js";

describe("recordEngagement", () => {
  it("view 重复只计一次(幂等)", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "view", undefined, 100);
    await recordEngagement(env, "s1", "u1", "view", undefined, 200);
    const c = await countsFor(env, ["s1"]);
    expect(c.s1.view).toBe(1);
  });

  it("不同用户的 view 各计一次", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "view", undefined, 100);
    await recordEngagement(env, "s1", "u2", "view", undefined, 100);
    const c = await countsFor(env, ["s1"]);
    expect(c.s1.view).toBe(2);
  });

  it("like on=true 计入,on=false 删除", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    expect((await countsFor(env, ["s1"])).s1.like).toBe(1);
    await recordEngagement(env, "s1", "u1", "like", false, 100);
    expect((await countsFor(env, ["s1"])).s1?.like || 0).toBe(0);
  });

  it("report 记录且按用户去重(重复举报只计一次)", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "report", undefined, 100);
    await recordEngagement(env, "s1", "u1", "report", undefined, 200);
    expect((await countsFor(env, ["s1"])).s1.report).toBe(1);
  });

  it("不同用户的 report 各计一次", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "report", undefined, 100);
    await recordEngagement(env, "s1", "u2", "report", undefined, 100);
    expect((await countsFor(env, ["s1"])).s1.report).toBe(2);
  });
});

describe("likedBy", () => {
  it("只返回该用户赞过的 shareId", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    await recordEngagement(env, "s2", "u2", "like", true, 100);
    const liked = await likedBy(env, "u1", ["s1", "s2"]);
    expect([...liked]).toEqual(["s1"]);
  });
});
