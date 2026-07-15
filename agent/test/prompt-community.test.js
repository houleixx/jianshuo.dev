import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { fakeEnv, fakeRecoD1 } from "./fakes.js";
import { promptShareId, publishPromptPost, retractPromptPost } from "../src/prompt-community.js";

const SECRET = "test-secret";
const OWNER = "users/anon-owner111/";
const LEAF = { label: "更毒舌", instruction: "把它改得更毒舌，观点不变。", appliesTo: ["text"] };

function makeEnv(seed = {}) {
  const e = fakeEnv(seed);
  e.SESSION_SECRET = SECRET;
  e.RECO_DB = fakeRecoD1();
  return e;
}

describe("promptShareId", () => {
  it("同码恒同 id，12 位", async () => {
    const a = await promptShareId("4563566", SECRET);
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(await promptShareId("4563566", SECRET)).toBe(a);
    expect(await promptShareId("4563567", SECRET)).not.toBe(a);
  });
});

describe("publishPromptPost", () => {
  it("写 community/<shareId>.json（kind=prompt, promptCode）+ D1 行", async () => {
    const e = makeEnv();
    const sid = await publishPromptPost(e, OWNER, "4563566", LEAF);
    const post = JSON.parse(await (await e.FILES.get(`community/${sid}.json`)).text());
    expect(post).toMatchObject({ schema: 2, shareId: sid, owner: OWNER,
      kind: "prompt", promptCode: "4563566" });
    expect(post.firstSharedAt).toBeTypeOf("number");
    const row = e.RECO_DB._posts.get(sid);
    expect(row).toMatchObject({ kind: "prompt", title: "更毒舌", has_photo: 0 });
  });

  it("复活保留 firstSharedAt（帖已存在时不重置）", async () => {
    const e = makeEnv();
    const sid = await publishPromptPost(e, OWNER, "4563566", LEAF);
    const t0 = JSON.parse(await (await e.FILES.get(`community/${sid}.json`)).text()).firstSharedAt;
    await publishPromptPost(e, OWNER, "4563566", LEAF);
    const t1 = JSON.parse(await (await e.FILES.get(`community/${sid}.json`)).text()).firstSharedAt;
    expect(t1).toBe(t0);
  });

  it("RECO_DB 缺失/写炸不打断（仍写 R2 返回 shareId）", async () => {
    const e = makeEnv();
    delete e.RECO_DB;
    const sid = await publishPromptPost(e, OWNER, "4563566", LEAF);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(await e.FILES.get(`community/${sid}.json`)).toBeTruthy();
  });
});

describe("retractPromptPost", () => {
  it("删帖删 D1 行；帖不存在时静默", async () => {
    const e = makeEnv();
    const sid = await publishPromptPost(e, OWNER, "4563566", LEAF);
    await retractPromptPost(e, "4563566");
    expect(await e.FILES.get(`community/${sid}.json`)).toBeNull();
    expect(e.RECO_DB._posts.get(sid)).toBeUndefined();
    await retractPromptPost(e, "4563566"); // 幂等不炸
  });
});
