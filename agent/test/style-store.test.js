import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import {
  readStyleDoc, resolveStyle, parseStyleMarkdown, readStyleText,
  writeStyleDoc, setStyleHead, STYLE_MAX_VERSIONS,
} from "../../functions/lib/style-store.js";

const KEY = "users/u/CLAUDE.json";
const LEGACY = "users/u/CLAUDE.md";

function seedDoc(versions, head, extra = {}) {
  return { schema: 3, head, versions, createdAt: 1000, updatedAt: 2000, ...extra };
}

describe("resolveStyle", () => {
  it("returns the head version's style", () => {
    const doc = seedDoc([
      { v: 1, savedAt: 1, source: "app", style: "老文风" },
      { v: 2, savedAt: 2, source: "agent", style: "新文风" },
    ], 2);
    expect(resolveStyle(doc)).toBe("新文风");
  });
  it("returns the head, not the latest, after an undo", () => {
    const doc = seedDoc([
      { v: 1, savedAt: 1, source: "app", style: "v1" },
      { v: 2, savedAt: 2, source: "agent", style: "v2" },
    ], 1);
    expect(resolveStyle(doc)).toBe("v1");
  });
  it("empty for null / no versions", () => {
    expect(resolveStyle(null)).toBe("");
    expect(resolveStyle({})).toBe("");
  });
});

describe("parseStyleMarkdown — legacy CLAUDE.md", () => {
  it("extracts the 文风 section under 「# 我的文风」", () => {
    expect(parseStyleMarkdown("# 我的名字\n王建硕\n\n# 我的文风\n口语一点，短句")).toBe("口语一点，短句");
  });
  it("no 「# 我的文风」 header → whole trimmed text", () => {
    expect(parseStyleMarkdown("就是这一段文风")).toBe("就是这一段文风");
  });
  it("empty input → empty", () => {
    expect(parseStyleMarkdown("")).toBe("");
    expect(parseStyleMarkdown(undefined)).toBe("");
  });
});

describe("readStyleText — CLAUDE.json first, legacy CLAUDE.md fallback", () => {
  it("reads the resolved style from CLAUDE.json when present", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify(seedDoc([{ v: 1, savedAt: 1, source: "app", style: "JSON 文风" }], 1)) });
    expect(await readStyleText(env, KEY, LEGACY)).toBe("JSON 文风");
  });
  it("falls back to the legacy CLAUDE.md 文风 section when CLAUDE.json is absent", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的名字\n王建硕\n\n# 我的文风\n回退文风" });
    expect(await readStyleText(env, KEY, LEGACY)).toBe("回退文风");
  });
  it("prefers CLAUDE.json even when a legacy CLAUDE.md also exists", async () => {
    const env = fakeEnv({
      [KEY]: JSON.stringify(seedDoc([{ v: 1, savedAt: 1, source: "app", style: "JSON 胜出" }], 1)),
      [LEGACY]: "# 我的文风\n旧的",
    });
    expect(await readStyleText(env, KEY, LEGACY)).toBe("JSON 胜出");
  });
  it("returns '' when neither exists", async () => {
    expect(await readStyleText(fakeEnv({}), KEY, LEGACY)).toBe("");
  });
});

describe("writeStyleDoc — versioned write", () => {
  it("first write creates schema-3 v1", async () => {
    const env = fakeEnv({});
    const doc = await writeStyleDoc(env, KEY, "第一版", "app");
    expect(doc.schema).toBe(3);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ v: 1, source: "app", style: "第一版" });
    const stored = JSON.parse(env.FILES._store.get(KEY));
    expect(resolveStyle(stored)).toBe("第一版");
  });

  it("second write appends v2 and moves head", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "v1", "app");
    const doc = await writeStyleDoc(env, KEY, "v2", "agent");
    expect(doc.head).toBe(2);
    expect(doc.versions.map((e) => e.style)).toEqual(["v1", "v2"]);
    expect(doc.versions[1].source).toBe("agent");
  });

  it("does NOT seed history from a legacy CLAUDE.md — first JSON write is v1", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的文风\n老的" });
    const doc = await writeStyleDoc(env, KEY, "新的", "app");
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].style).toBe("新的");
  });

  it("writing after an undo truncates future versions before appending", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "v1", "app");   // head 1
    await writeStyleDoc(env, KEY, "v2", "app");   // head 2
    await setStyleHead(env, KEY, 1);              // undo to v1
    const doc = await writeStyleDoc(env, KEY, "v1b", "app"); // branch off v1
    expect(doc.head).toBe(2);
    expect(doc.versions.map((e) => e.style)).toEqual(["v1", "v1b"]); // v2 dropped
  });

  it("prunes to STYLE_MAX_VERSIONS oldest-first", async () => {
    const env = fakeEnv({});
    for (let i = 1; i <= STYLE_MAX_VERSIONS + 3; i++) await writeStyleDoc(env, KEY, `v${i}`, "app");
    const doc = await readStyleDoc(env, KEY);
    expect(doc.versions).toHaveLength(STYLE_MAX_VERSIONS);
    expect(doc.head).toBe(STYLE_MAX_VERSIONS + 3);
    expect(doc.versions[doc.versions.length - 1].style).toBe(`v${STYLE_MAX_VERSIONS + 3}`);
  });
});

describe("setStyleHead — undo/redo pointer move", () => {
  it("moves head to a valid version without adding one", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "v1", "app");
    await writeStyleDoc(env, KEY, "v2", "app");
    const doc = await setStyleHead(env, KEY, 1);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(2);
    expect(resolveStyle(doc)).toBe("v1");
  });
  it("returns null for an out-of-range head", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "v1", "app");
    expect(await setStyleHead(env, KEY, 99)).toBeNull();
  });
  it("returns null when the doc is missing", async () => {
    expect(await setStyleHead(fakeEnv({}), KEY, 1)).toBeNull();
  });
});
