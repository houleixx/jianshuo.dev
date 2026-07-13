import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { flattenTemplate, updateTemplatePrompt, handlePromptRegistry } from "../src/prompt-registry.js";
import { DEFAULT_PROMPT_TEMPLATE } from "../src/prompt-template.js";
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";

describe("flattenTemplate — 对外形状不变 {id,label,instruction}", () => {
  const flat = flattenTemplate(DEFAULT_PROMPT_TEMPLATE);

  it("只收 action（12 条），group 不收（无 instruction）", () => {
    expect(flat.length).toBe(12);
    for (const p of flat) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(typeof p.instruction).toBe("string");
    }
  });

  it("id 是 sys_*，label 带父组前缀（和老的 `父 · 叶` 一致，调优页靠它认人）", () => {
    const cartoon = flat.find((p) => p.id === "sys_cartoon");
    expect(cartoon.label).toBe("图片风格 · 卡通");
    expect(cartoon.instruction).toContain("宫崎骏");
    const cover = flat.find((p) => p.id === "sys_wechat_cover");
    expect(cover.label).toBe("插入图片 · 公众号题图");
  });
});

describe("updateTemplatePrompt", () => {
  it("改一条 → 返回改过的深拷贝，原对象不动", () => {
    const next = updateTemplatePrompt(DEFAULT_PROMPT_TEMPLATE, "sys_cartoon", "新的卡通指令");
    const idOf = (t, id) => flattenTemplate(t).find((p) => p.id === id).instruction;
    expect(idOf(next, "sys_cartoon")).toBe("新的卡通指令");
    expect(idOf(DEFAULT_PROMPT_TEMPLATE, "sys_cartoon")).toContain("宫崎骏"); // 原对象没被改
  });

  it("改顶层 action（不在组里）也行", () => {
    const tpl = { schema: 1, items: [{ id: "sys_top", type: "action", label: "顶层", prompt: "旧", appliesTo: ["text"] }] };
    expect(flattenTemplate(updateTemplatePrompt(tpl, "sys_top", "新"))[0].instruction).toBe("新");
  });

  it("id 不存在 → null", () => {
    expect(updateTemplatePrompt(DEFAULT_PROMPT_TEMPLATE, "sys_nope", "x")).toBeNull();
  });

  it("group id → null（组没有 instruction 可改）", () => {
    expect(updateTemplatePrompt(DEFAULT_PROMPT_TEMPLATE, "sys_style", "x")).toBeNull();
  });
});

// ── 路由层：/agent/prompt-registry（管理 token）───────────────────────────────
// 核心 global 提示词（mine.system 等）的合并 / config/prompts.json 覆盖层由
// prompt-registry-core.test.js 单独盯；这里只管模板这一半 + 鉴权 + CORS + 写回位置。
describe("/agent/prompt-registry 路由（管理 token）", () => {
  const ADMIN = { FILES_TOKEN: "admintok" };
  const H = { Authorization: "Bearer admintok" };

  it("GET → {prompts:[…]}：12 条模板叶子 + 6 条核心 global 提示词 = 18", async () => {
    const env = { ...fakeEnv(), ...ADMIN };
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", { headers: H }), env);
    expect(res.status).toBe(200);
    const { prompts } = await res.json();
    expect(prompts.length).toBe(18);
    const cartoon = prompts.find((p) => p.id === "sys_cartoon");
    expect(cartoon.label).toBe("图片风格 · 卡通");
    expect(cartoon.instruction).toContain("宫崎骏");
  });

  it("PUT 模板叶子 → 写回 config/prompt-template.json（不再碰 config/ui-config.json），GET 立刻读到新值", async () => {
    const env = { ...fakeEnv(), ...ADMIN };
    const put = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      method: "PUT", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ id: "sys_cartoon", instruction: "调优后的卡通" }),
    }), env);
    expect(put.status).toBe(200);
    expect(env.FILES._store.has("config/prompt-template.json")).toBe(true);
    expect(env.FILES._store.has("config/ui-config.json")).toBe(false);

    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", { headers: H }), env);
    const hit = (await res.json()).prompts.find((p) => p.id === "sys_cartoon");
    expect(hit.instruction).toBe("调优后的卡通");
  });

  it("PUT 未知模板 id → 404；缺字段 → 400", async () => {
    const env = { ...fakeEnv(), ...ADMIN };
    const put404 = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      method: "PUT", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ id: "sys_nope", instruction: "x" }),
    }), env);
    expect(put404.status).toBe(404);

    const put400 = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      method: "PUT", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ id: "sys_cartoon" }),
    }), env);
    expect(put400.status).toBe(400);
  });

  it("非管理 token → 401", async () => {
    const env = { ...fakeEnv(), ...ADMIN };
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      headers: { Authorization: "Bearer anon_testtoken1234567890" },
    }), env);
    expect(res.status).toBe(401);
  });

  it("CORS：prompt.jianshuo.dev 放行，其他 Origin 不带头", async () => {
    const env = { ...fakeEnv(), ...ADMIN };
    const ok = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      method: "OPTIONS", headers: { Origin: "https://prompt.jianshuo.dev" },
    }), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://prompt.jianshuo.dev");

    const other = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-registry", {
      headers: { ...H, Origin: "https://evil.example" },
    }), env);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// handlePromptRegistry 也可以脱离 worker 路由直接调用（同一个函数，两种测法互补）。
describe("handlePromptRegistry — 直接调用同样生效", () => {
  it("无 token → 401", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: "admintok" };
    const req = new Request("https://jianshuo.dev/agent/prompt-registry");
    expect((await handlePromptRegistry(req, env)).status).toBe(401);
  });
});
