import { describe, it, expect } from "vitest";
import { handlePromptRegistry } from "../src/prompt-registry.js";
import { fakeEnv } from "./fakes.js";

const TOK = "test-files-token";
const req = (method, body) => new Request("https://jianshuo.dev/agent/prompt-registry", {
  method, headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});

describe("prompt-registry core prompts", () => {
  it("GET 列表含核心 global 提示词、不含 locked", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: TOK };
    const res = await handlePromptRegistry(req("GET"), env);
    const { prompts } = await res.json();
    const ids = prompts.map((p) => p.id);
    expect(ids).toContain("mine.system");
    expect(ids).toContain("image.write");
    expect(ids).not.toContain("mine.imageOnly"); // locked
  });
  it("PUT 核心 id 写入 config/prompts.json", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: TOK };
    const res = await handlePromptRegistry(req("PUT", { id: "mine.system", instruction: "NEW" }), env);
    expect(res.status).toBe(200);
    const saved = JSON.parse(await (await env.FILES.get("config/prompts.json")).text());
    expect(saved.prompts["mine.system"]).toBe("NEW");
  });
  it("PUT 空 instruction 拒绝 400", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: TOK };
    const res = await handlePromptRegistry(req("PUT", { id: "mine.system", instruction: "  " }), env);
    expect(res.status).toBe(400);
  });
  it("PUT locked id 拒绝", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: TOK };
    const res = await handlePromptRegistry(req("PUT", { id: "mine.imageOnly", instruction: "x" }), env);
    expect([400, 404]).toContain(res.status);
  });
});
