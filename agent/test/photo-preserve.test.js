import { describe, it, expect, vi } from "vitest";
import { ensurePhotoMarkers, photoKeysIn } from "../src/miner.js";
import { runTool } from "../src/tools.js";

const K1 = "photos/2026-07-01-090000/12-abc.jpg";
const K2 = "photos/2026-07-01-090000/45-def.jpg";

describe("ensurePhotoMarkers（改写/合并不丢照片的程序化保底）", () => {
  it("新稿丢了标记 → 按原顺序补到最后一篇末尾，独占一行", () => {
    const src = [{ body: `开头\n\n[[photo:${K1}]]\n\n中段\n\n[[photo:${K2}]]\n\n结尾` }];
    const out = ensurePhotoMarkers(src, [{ title: "改", body: "全新改写的正文，没带图。" }]);
    expect(photoKeysIn(out)).toEqual([K1, K2]);
    expect(out[0].body).toMatch(new RegExp(`\\n\\[\\[photo:${K1.replace(/[/.]/g, "\\$&")}\\]\\]\\n`));
  });

  it("新稿保留了全部标记 → 原样返回，不重复追加", () => {
    const src = [{ body: `[[photo:${K1}]]\n正文` }];
    const kept = [{ title: "t", body: `改写正文\n\n[[photo:${K1}]]\n` }];
    const out = ensurePhotoMarkers(src, kept);
    expect(out).toEqual(kept);
    expect((out[0].body.match(/\[\[photo:/g) || []).length).toBe(1);
  });

  it("多篇拆分时只要有一篇带着就算保留；缺的补给最后一篇", () => {
    const src = [{ body: `[[photo:${K1}]]\n\n[[photo:${K2}]]` }];
    const out = ensurePhotoMarkers(src, [
      { title: "一", body: `甲\n\n[[photo:${K1}]]` },
      { title: "二", body: "乙（没图）" },
    ]);
    expect(photoKeysIn([out[0]])).toEqual([K1]);
    expect(photoKeysIn([out[1]])).toEqual([K2]);   // 缺的 K2 落在最后一篇
  });

  it("源没有照片 / 新稿为空数组 → 不动", () => {
    expect(ensurePhotoMarkers([{ body: "无图" }], [{ title: "t", body: "b" }])[0].body).toBe("b");
    expect(ensurePhotoMarkers([{ body: `[[photo:${K1}]]` }], [])).toEqual([]);
  });
});

describe("merge_articles 不丢照片", () => {
  function memFiles(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
      _store: store,
      async get(k) { return store.has(k) ? { async text() { return store.get(k); } } : null; },
      async put(k, v) { store.set(k, typeof v === "string" ? v : "BYTES"); },
      async head(k) { return store.has(k) ? null : null; },
      async delete(k) { store.delete(k); },
      async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    };
  }
  const SCOPE = "users/abc/";
  const art = (t, b) => JSON.stringify({ schema: 2, articles: [{ title: t, body: b }], transcript: "", createdAt: 1 });

  it("模型合并稿丢图 → 写出的正文被补回全部 [[photo:]]", async () => {
    const env = { FILES: memFiles({
      [`${SCOPE}articles/A.json`]: art("甲", `甲文\n\n[[photo:${K1}]]`),
      [`${SCOPE}articles/B.json`]: art("乙", `乙文\n\n[[photo:${K2}]]`),
    }) };
    // 模型返回的合并稿把两张图都弄丢了
    const callClaude = vi.fn(async () => ({ content: [{ type: "text", text: "合璧\n合并后的正文，一张图都没带。" }], usage: {} }));
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const r = await runTool("merge_articles", { stems: ["A", "B"] },
      { env, scope: SCOPE, token: "tk", origin: "https://jianshuo.dev", callClaude, idemKey: "k9" });
    expect(r.ok).toBe(true);
    const put = fetchSpy.mock.calls.find(([u, o]) => o?.method === "PUT" && String(u).includes("/files/api/articles/"));
    const outBody = JSON.parse(put[1].body).articles[0].body;
    expect(outBody).toContain(`[[photo:${K1}]]`);
    expect(outBody).toContain(`[[photo:${K2}]]`);
    vi.unstubAllGlobals();
  });
});
