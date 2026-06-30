import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import {
  readStyleDoc, resolveStyle, parseStyleMarkdown, readStyleText,
  writeStyleDoc, setStyleHead, STYLE_MAX_VERSIONS,
  readProfileName, mergeProfile,
  styleLabel, styleComment, prependStyleComment,
  DEFAULT_STYLE, ensureStyleSeeded, isDefaultSeed,
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

describe("profile — non-versioned name (changing it must NOT mint a style version)", () => {
  it("mergeProfile sets name without touching versions/head", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "文风v1", "app");          // head 1
    const doc = await mergeProfile(env, KEY, { name: "王建硕" });
    expect(doc.profile).toEqual({ name: "王建硕" });
    expect(doc.head).toBe(1);                                // no new version
    expect(doc.versions).toHaveLength(1);
    expect(resolveStyle(doc)).toBe("文风v1");
  });

  it("mergeProfile lazily creates a minimal doc when none exists", async () => {
    const env = fakeEnv({});
    const doc = await mergeProfile(env, KEY, { name: "小明" });
    expect(doc.profile.name).toBe("小明");
    expect(doc.versions).toEqual([]);
    expect(doc.head).toBe(0);
  });

  it("writeStyleDoc PRESERVES an existing profile across a style write", async () => {
    const env = fakeEnv({});
    await mergeProfile(env, KEY, { name: "王建硕" });          // profile only, no version
    const doc = await writeStyleDoc(env, KEY, "新文风", "app");
    expect(doc.profile).toEqual({ name: "王建硕" });          // survived the style write
    expect(resolveStyle(doc)).toBe("新文风");
  });

  it("setStyleHead preserves the profile", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "v1", "app");
    await writeStyleDoc(env, KEY, "v2", "app");
    await mergeProfile(env, KEY, { name: "阿王" });
    const doc = await setStyleHead(env, KEY, 1);
    expect(doc.profile.name).toBe("阿王");
  });

  it("readProfileName: profile.name (CLAUDE.json) wins", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify(seedDoc([{ v: 1, savedAt: 1, source: "app", style: "x" }], 1, { profile: { name: "JSON名" } })) });
    expect(await readProfileName(env, KEY, LEGACY)).toBe("JSON名");
  });

  it("readProfileName: falls back to the legacy CLAUDE.md「# 我的名字」", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的名字\n王建硕\n\n# 我的文风\nx" });
    expect(await readProfileName(env, KEY, LEGACY)).toBe("王建硕");
  });

  it("readProfileName: '' when neither exists", async () => {
    expect(await readProfileName(fakeEnv({}), KEY, LEGACY)).toBe("");
  });
});

describe("style comment protocol — <!-- style: 风格 vN --> (canonical format)", () => {
  it("styleLabel / styleComment are the single source of the format", () => {
    expect(styleLabel(8)).toBe("风格 v8");
    expect(styleComment(8)).toBe("<!-- style: 风格 v8 -->");
  });
  it("prependStyleComment tags the body so the reader's chip + reuse-match can read it", () => {
    const body = prependStyleComment("正文第一段", 7);
    expect(body.startsWith("<!-- style: 风格 v7 -->")).toBe(true);
    // The version number is recoverable for the app's reuse-if-present matcher.
    expect(body.match(/<!--\s*style:\s*风格 v(\d+)\s*-->/)[1]).toBe("7");
  });
});

describe("DEFAULT_STYLE — canonical 默认王建硕风格（mine.js re-export 自此）", () => {
  it("含王建硕语气 DNA 标记", () => {
    expect(DEFAULT_STYLE).toContain("胸有成竹");
    expect(DEFAULT_STYLE).toContain("绝不用「笔者」");
  });
  it("mine.js 的 MINE_DEFAULT_STYLE 与之字节一致", async () => {
    const { MINE_DEFAULT_STYLE } = await import("../src/prompts/mine.js");
    expect(MINE_DEFAULT_STYLE).toBe(DEFAULT_STYLE);
  });
});

describe("ensureStyleSeeded — 懒种子默认文风为 v1", () => {
  it("无 CLAUDE.json / 无 legacy → 种 v1（source=default），isDefaultSeed=true", async () => {
    const env = fakeEnv({});
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ v: 1, source: "default", style: DEFAULT_STYLE });
    expect(isDefaultSeed(doc)).toBe(true);
    // 已落库
    expect(resolveStyle(JSON.parse(env.FILES._store.get(KEY)))).toBe(DEFAULT_STYLE);
  });

  it("幂等：再调一次不产生 v2", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
  });

  it("已有 CLAUDE.json → 原样返回，不被默认覆盖", async () => {
    const env = fakeEnv({});
    await writeStyleDoc(env, KEY, "我自己的文风", "app");   // head 1, source app
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc.head).toBe(1);
    expect(doc.versions[0]).toMatchObject({ source: "app", style: "我自己的文风" });
    expect(isDefaultSeed(doc)).toBe(false);                 // source 非 default
  });

  it("遗留 CLAUDE.md 有文风 → 不种，返回 null，CLAUDE.json 仍不存在", async () => {
    const env = fakeEnv({ [LEGACY]: "# 我的名字\n王建硕\n\n# 我的文风\n老用户的文风" });
    const doc = await ensureStyleSeeded(env, KEY, LEGACY);
    expect(doc).toBeNull();
    expect(env.FILES._store.has(KEY)).toBe(false);
  });

  it("isDefaultSeed：种 v1 后编辑成 v2 → false", async () => {
    const env = fakeEnv({});
    await ensureStyleSeeded(env, KEY, LEGACY);              // v1 default
    const doc = await writeStyleDoc(env, KEY, "改成我的", "app"); // v2
    expect(doc.head).toBe(2);
    expect(isDefaultSeed(doc)).toBe(false);
  });
});
