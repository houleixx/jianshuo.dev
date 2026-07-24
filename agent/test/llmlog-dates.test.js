// GET /files/api/llmlog/dates 与 minelog/dates — 日期文件夹列表必须跟着 cursor
// 翻页：R2 的 delimited list 按「扫过的 key 数」截断而不是按返回的前缀数，老日志
// 攒多之后一次 list 只滚出最老的一段日期，新日期永远不出现（2026-07 实况：llm
// 管理页停在 07-13，而 R2 里每天都在写）。
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

// 两页截断的 delimited listing：第一页只滚出老日期并给 cursor，第二页给新日期。
function truncatingFiles(prefix) {
  const page1 = ["2026-07-11", "2026-07-12", "2026-07-13"].map((d) => `${prefix}${d}/`);
  const page2 = ["2026-07-14", "2026-07-24"].map((d) => `${prefix}${d}/`);
  const calls = [];
  const files = {
    calls,
    async list(opts) {
      calls.push(opts);
      if (opts.prefix !== prefix || opts.delimiter !== "/") return { objects: [], delimitedPrefixes: [] };
      if (!opts.cursor) return { objects: [], delimitedPrefixes: page1, truncated: true, cursor: "c1" };
      expect(opts.cursor).toBe("c1");
      return { objects: [], delimitedPrefixes: page2, truncated: false };
    },
  };
  return files;
}

async function getDates(kind, prefix) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  env.FILES = truncatingFiles(prefix);
  const request = new Request(`https://jianshuo.dev/files/api/${kind}/dates`, {
    headers: { Authorization: "Bearer admin" },
  });
  const resp = await onRequest({ request, env, params: { path: [kind, "dates"] } });
  expect(resp.status).toBe(200);
  return (await resp.json()).dates;
}

describe("llmlog/minelog dates — delimited list 截断要翻页", () => {
  it("llmlog/dates 跨 cursor 拿全日期，新日期在最前", async () => {
    const dates = await getDates("llmlog", "llmlogs/");
    expect(dates).toEqual(["2026-07-24", "2026-07-14", "2026-07-13", "2026-07-12", "2026-07-11"]);
  });

  it("minelog/dates 同一条翻页路径", async () => {
    const dates = await getDates("minelog", "minelogs/");
    expect(dates).toEqual(["2026-07-24", "2026-07-14", "2026-07-13", "2026-07-12", "2026-07-11"]);
  });
});
