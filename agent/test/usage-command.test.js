// test/usage-command.test.js
// Unit coverage for meteredCommandGate (agent/src/index.js) — library-level
// command gate: balance-only, no per-article cap. vi.mock is hoisted before
// static imports to keep the real `agents` package (cloudflare:workers) out
// of the test — same pattern as style-extract-route.test.js.
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { meteredCommandGate } from "../src/index.js";

describe("meteredCommandGate", () => {
  it("无 USAGE 绑定 → fail-open ok", async () => {
    expect(await meteredCommandGate(undefined, "users/x/", Date.now())).toBe("ok");
  });
});
