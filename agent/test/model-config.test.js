// Tests for the admin "挖文模型设置" plumbing: how config/model.json is read by
// the miner (loadModelConfig), how the voice-editor picks a model from it
// (resolveEditModel — editing is Anthropic-only), and the guard that aborts a
// mine run when the selected provider's API key secret is missing.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  loadModelConfig,
  resolveEditModel,
  runMine,
  MINE_MODEL_DEFAULT,
  EDIT_MODEL_DEFAULT,
} from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

// env = R2 (FILES) + the API-key secrets the Worker would hold.
function env(seed = {}, secrets = {}) {
  return { ...fakeEnv(seed), ...secrets };
}
function cfg(obj) {
  return { "config/model.json": JSON.stringify(obj) };
}

describe("loadModelConfig", () => {
  it("no config → Anthropic default model + CLAUDE_API_KEY", async () => {
    const c = await loadModelConfig(env({}, { CLAUDE_API_KEY: "sk-ant" }));
    expect(c.providerKey).toBe("anthropic");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe(MINE_MODEL_DEFAULT);
    expect(c.apiKey).toBe("sk-ant");
  });

  it("Anthropic config honors a custom Claude model, keeps CLAUDE_API_KEY", async () => {
    const c = await loadModelConfig(
      env(cfg({ providerKey: "anthropic", model: "claude-opus-4-8" }), { CLAUDE_API_KEY: "sk-ant" }),
    );
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-opus-4-8");
    expect(c.apiKey).toBe("sk-ant");
  });

  it("non-Anthropic provider → openai-compat, baseUrl + the provider's own secret", async () => {
    const c = await loadModelConfig(
      env(cfg({ providerKey: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
          { DEEPSEEK_API_KEY: "sk-ds", CLAUDE_API_KEY: "sk-ant" }),
    );
    expect(c.provider).toBe("openai-compat");
    expect(c.model).toBe("deepseek-chat");
    expect(c.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(c.apiKey).toBe("sk-ds"); // NOT the Claude key
  });

  it("selected provider but its secret is unset → apiKey is empty (the silent-401 precondition)", async () => {
    const c = await loadModelConfig(
      env(cfg({ providerKey: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
          { CLAUDE_API_KEY: "sk-ant" }), // no DEEPSEEK_API_KEY
    );
    expect(c.providerKey).toBe("deepseek");
    expect(c.apiKey).toBe("");
  });
});

describe("resolveEditModel (voice editing uses a fast Claude model, decoupled from mining)", () => {
  it("ignores the mining provider/model — always the fast edit default", () => {
    expect(resolveEditModel({ providerKey: "deepseek", model: "deepseek-chat" })).toBe(EDIT_MODEL_DEFAULT);
    expect(resolveEditModel({ providerKey: "anthropic", model: "claude-opus-4-8" })).toBe(EDIT_MODEL_DEFAULT);
    expect(EDIT_MODEL_DEFAULT).not.toBe(MINE_MODEL_DEFAULT); // editing model is faster than mining default
  });
  it("honors an explicit Claude editModel override", () => {
    expect(resolveEditModel({ editModel: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  });
  it("ignores a non-Claude editModel and missing cfg", () => {
    expect(resolveEditModel({ editModel: "deepseek-chat" })).toBe(EDIT_MODEL_DEFAULT);
    expect(resolveEditModel(null)).toBe(EDIT_MODEL_DEFAULT);
  });
});

describe("runMine guard: abort when the selected provider's key is missing", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("aborts loudly and makes no LLM/ASR call, even with audio waiting", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("fetch must not be called when key is missing"); });
    vi.stubGlobal("fetch", fetchSpy);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = env(
      {
        ...cfg({ providerKey: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
        // an unprocessed recording — without the guard this would reach ASR/LLM
        "users/u1/VoiceDrop-2026-06-26-120000-30-fri-am.m4a": "fakeaudio",
      },
      { CLAUDE_API_KEY: "sk-ant" }, // DEEPSEEK_API_KEY missing
    );
    await expect(runMine(e)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    // the abort must name the missing Worker Secret so admin can fix it
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/DEEPSEEK_API_KEY/);
  });
});

describe("loadModelConfig: imagePipeline 开关", () => {
  it("config/model.json 里 true → true；缺省 → false；无 config → false", async () => {
    const on = await loadModelConfig(env(cfg({ providerKey: "anthropic", imagePipeline: true }), { CLAUDE_API_KEY: "k" }));
    expect(on.imagePipeline).toBe(true);
    const off = await loadModelConfig(env(cfg({ providerKey: "anthropic" }), { CLAUDE_API_KEY: "k" }));
    expect(off.imagePipeline).toBe(false);
    const noCfg = await loadModelConfig(env({}, { CLAUDE_API_KEY: "k" }));
    expect(noCfg.imagePipeline).toBe(false);
  });
});
