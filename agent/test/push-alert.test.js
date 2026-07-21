import { describe, it, expect, vi } from "vitest";
import { alertAdminThrottled } from "../src/push.js";
import { fakeEnv } from "./fakes.js";

// alertAdminThrottled：给管理员推「重要失败」报警，但同一 ruleKey 在窗口内只推一次
// （失败常成串——如 realtime 重连风暴，不节流会把手机轰炸成灾）。节流 marker 存 R2。
const MSG = { title: "t", body: "b" };
const WINDOW = 60 * 60 * 1000;

describe("alertAdminThrottled", () => {
  it("无 ADMIN_SCOPE：不推、返回 false、不落 marker", async () => {
    const env = fakeEnv();                       // 没有 ADMIN_SCOPE
    const push = vi.fn(async () => true);
    expect(await alertAdminThrottled(env, "k", WINDOW, MSG, push)).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(env.FILES._store.has("ops/alerts/k.json")).toBe(false);
  });

  it("首次推送并落节流 marker，管理员 scope 正确", async () => {
    const env = { ...fakeEnv(), ADMIN_SCOPE: "users/admin/" };
    const push = vi.fn(async () => true);
    expect(await alertAdminThrottled(env, "realtime-openai-fatal", WINDOW, MSG, push)).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toBe("users/admin/");
    const marker = JSON.parse(env.FILES._store.get("ops/alerts/realtime-openai-fatal.json"));
    expect(marker.at).toBeGreaterThan(0);
  });

  it("窗口内二次调用被节流：不再推", async () => {
    const env = { ...fakeEnv(), ADMIN_SCOPE: "users/admin/" };
    const push = vi.fn(async () => true);
    await alertAdminThrottled(env, "k", WINDOW, MSG, push);
    const r2 = await alertAdminThrottled(env, "k", WINDOW, MSG, push);
    expect(r2).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);       // 只推了一次
  });

  it("marker 过期（超出窗口）后可再次推送", async () => {
    const env = { ...fakeEnv(), ADMIN_SCOPE: "users/admin/" };
    const push = vi.fn(async () => true);
    await alertAdminThrottled(env, "k", WINDOW, MSG, push);
    // 把 marker 时间戳倒拨到窗口之外
    env.FILES._store.set("ops/alerts/k.json", JSON.stringify({ at: Date.now() - WINDOW - 1000 }));
    expect(await alertAdminThrottled(env, "k", WINDOW, MSG, push)).toBe(true);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("不同 ruleKey 互不节流", async () => {
    const env = { ...fakeEnv(), ADMIN_SCOPE: "users/admin/" };
    const push = vi.fn(async () => true);
    await alertAdminThrottled(env, "a", WINDOW, MSG, push);
    await alertAdminThrottled(env, "b", WINDOW, MSG, push);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
