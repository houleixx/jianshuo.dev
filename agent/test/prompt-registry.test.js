import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { DEFAULT_UI_CONFIG } from "../src/ui-config.js";
import { flattenPrompts, updatePrompt, handlePromptRegistry } from "../src/prompt-registry.js";
import { fakeEnv } from "./fakes.js";

const COVER_ID = "voice-editor.longpress.text.insert.wechat-cover";

describe("flattenPrompts — ui-config 叶子指令打平", () => {
  const prompts = flattenPrompts(DEFAULT_UI_CONFIG);

  it("11 条叶子：6 图片风格 + 4 改写 + 1 题图，id 是层级路径", () => {
    expect(prompts.length).toBe(11);
    const ids = prompts.map((p) => p.id);
    expect(ids).toContain("voice-editor.longpress.image.style.cartoon");
    expect(ids).toContain("voice-editor.longpress.text.rewrite.concise");
    expect(ids).toContain(COVER_ID);
  });

  it("label 带父菜单前缀，instruction 原样", () => {
    const cover = prompts.find((p) => p.id === COVER_ID);
    expect(cover.label).toBe("插入图片 · 公众号题图");
    expect(cover.instruction).toContain("2.45:1");
  });
});

describe("updatePrompt — 只改目标叶子，深拷贝不动原对象", () => {
  it("改题图指令，其余 10 条不变", () => {
    const next = updatePrompt(DEFAULT_UI_CONFIG, COVER_ID, "新版题图指令");
    const before = flattenPrompts(DEFAULT_UI_CONFIG);
    const after = flattenPrompts(next);
    expect(after.find((p) => p.id === COVER_ID).instruction).toBe("新版题图指令");
    expect(after.filter((p) => p.id !== COVER_ID)).toEqual(before.filter((p) => p.id !== COVER_ID));
    expect(flattenPrompts(DEFAULT_UI_CONFIG).find((p) => p.id === COVER_ID).instruction).toContain("2.45:1");
  });

  it("未知 id → null", () => {
    expect(updatePrompt(DEFAULT_UI_CONFIG, "voice-editor.longpress.text.insert.nope", "x")).toBeNull();
  });
});

describe("handlePromptRegistry — 管理 token 门禁 + R2 覆盖写回", () => {
  const ADMIN = "admin-token";
  const req = (method, { token, body, origin } = {}) =>
    new Request("https://jianshuo.dev/agent/prompt-registry", {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const envWith = () => ({ ...fakeEnv(), FILES_TOKEN: ADMIN });

  it("无 token / 错 token → 401", async () => {
    const env = envWith();
    expect((await handlePromptRegistry(req("GET"), env)).status).toBe(401);
    expect((await handlePromptRegistry(req("GET", { token: "wrong" }), env)).status).toBe(401);
  });

  it("GET → 生效版打平列表（无 R2 覆盖时即内置缺省）", async () => {
    const res = await handlePromptRegistry(req("GET", { token: ADMIN }), envWith());
    expect(res.status).toBe(200);
    const { prompts } = await res.json();
    expect(prompts.length).toBe(11);
    expect(prompts.find((p) => p.id === COVER_ID).instruction).toContain("2.45:1");
  });

  it("PUT 改题图 → 写 R2 覆盖，随后 GET 读到新版", async () => {
    const env = envWith();
    const res = await handlePromptRegistry(req("PUT", { token: ADMIN, body: { id: COVER_ID, instruction: "新版题图指令" } }), env);
    expect(res.status).toBe(200);
    expect(env.FILES._store.has("config/ui-config.json")).toBe(true);
    const again = await handlePromptRegistry(req("GET", { token: ADMIN }), env);
    const { prompts } = await again.json();
    expect(prompts.find((p) => p.id === COVER_ID).instruction).toBe("新版题图指令");
  });

  it("PUT 未知 id → 404；缺字段 → 400", async () => {
    const env = envWith();
    expect((await handlePromptRegistry(req("PUT", { token: ADMIN, body: { id: "x.y.z", instruction: "x" } }), env)).status).toBe(404);
    expect((await handlePromptRegistry(req("PUT", { token: ADMIN, body: { id: COVER_ID } }), env)).status).toBe(400);
  });

  it("CORS：prompt.jianshuo.dev 放行，其他 Origin 不带头", async () => {
    const env = envWith();
    const ok = await handlePromptRegistry(req("OPTIONS", { origin: "https://prompt.jianshuo.dev" }), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://prompt.jianshuo.dev");
    const other = await handlePromptRegistry(req("GET", { token: ADMIN, origin: "https://evil.example" }), env);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
