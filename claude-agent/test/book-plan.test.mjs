// 并发闸门 planLaunches 的单测（2026-09-12）：活着的不碰、空位先来先起、起过但单元没了
// 按次数续跑或放弃、上限满了谁都不起。
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLaunches } from "../dist/book-launch.js";

const base = {
  kind: "create", seed: "嘟嘟", scope: "users/anon-ae209/", author: "王建硕", attempts: 0,
};
const q = (jobId, startedAt, over = {}) => ({ ...base, jobId, startedAt, ...over });

test("活着的不碰，空位按先来先起，其余排队", () => {
  const recs = [q("c", 3), q("a", 1), q("b", 2)];
  const plan = planLaunches(recs, new Set(["book-x"]), 2); // 已有 1 个在跑，剩 1 个空位
  assert.deepEqual(plan.launch.map((r) => r.jobId), ["a"]);
  assert.deepEqual(plan.queued.map((r) => r.jobId), ["b", "c"]);
  assert.equal(plan.running.length, 0);
});

test("单元还在跑的记录归 running，只占它自己的位置", () => {
  const recs = [q("a", 1, { attempts: 1 }), q("b", 2)];
  const plan = planLaunches(recs, new Set(["book-a"]), 2);
  assert.deepEqual(plan.running.map((r) => r.jobId), ["a"]);
  assert.deepEqual(plan.launch.map((r) => r.jobId), ["b"]); // 2 上限 - 1 活着 = 1 空位
});

test("起过但单元没了 → 次数没到上限续跑，到了就放弃", () => {
  const recs = [q("dead1", 1, { attempts: 1 }), q("dead2", 2, { attempts: 2 })];
  const plan = planLaunches(recs, new Set(), 5);
  assert.deepEqual(plan.launch.map((r) => r.jobId), ["dead1"]);
  assert.deepEqual(plan.giveUp.map((r) => r.jobId), ["dead2"]);
});

test("上限为 0 或已满时什么都不起", () => {
  assert.equal(planLaunches([q("a", 1)], new Set(["book-p", "book-q"]), 2).launch.length, 0);
  assert.equal(planLaunches([q("a", 1)], new Set(), 0).launch.length, 0);
});

test("修书单按 revise-<slug>-<ts> 对活着的单元", () => {
  const rev = { kind: "revise", slug: "dudu", scope: "s", author: "", instruction: "x", entryTs: 7, startedAt: 7, attempts: 1 };
  assert.equal(planLaunches([rev], new Set(["revise-dudu-7"]), 1).running.length, 1);
});
