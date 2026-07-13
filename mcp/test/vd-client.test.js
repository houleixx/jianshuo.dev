import { describe, it, expect } from "vitest";
import { createClient, FILES_ORIGIN, AGENT_ORIGIN, RECO_ORIGIN } from "../src/vd-client.js";

// 抓住客户端发出的请求，好断言 URL / 方法 / 头 / body。
function spyFetch(responder = () => new Response("{}", { status: 200 })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    return responder(String(url), init);
  };
  return { fetch, calls };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("出站源路由", () => {
  it("files() 打 jianshuo.dev 的 Pages Files API", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "anon_x", fetch }).files("GET", "articles");

    expect(calls[0].url).toBe(`${FILES_ORIGIN}/files/api/articles`);
    expect(FILES_ORIGIN).toBe("https://jianshuo.dev");
  });

  it("agent() 必须走 workers.dev，不能走同 zone 的 jianshuo.dev/agent/*", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "anon_x", fetch }).agent("POST", "mine/trigger");

    // 同 zone 走 jianshuo.dev/agent/* 会被 Pages 路由 405 掉
    // （见 functions/files/api/[[path]].js:1431 的同款注释）。
    expect(calls[0].url).toBe("https://voicedrop-agent.jianshuo.workers.dev/agent/mine/trigger");
    expect(AGENT_ORIGIN).not.toContain("jianshuo.dev/agent");
  });

  it("reco() 走 reco worker 的 workers.dev", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "anon_x", fetch }).reco("GET", "feed");

    expect(calls[0].url).toBe(`${RECO_ORIGIN}/reco/feed`);
  });
});

describe("请求构造", () => {
  it("每个请求都带 Bearer token", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "anon_abc", fetch }).files("GET", "whoami");

    expect(calls[0].headers.Authorization).toBe("Bearer anon_abc");
  });

  it("有 body 时序列化成 JSON 并带 content-type", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "t", fetch }).files("PUT", "articles/abc", { body: { articles: [] } });

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toBe(JSON.stringify({ articles: [] }));
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("path 里的每一段都做 URL 编码（stem 可能带特殊字符）", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "t", fetch }).files("GET", ["articles", "a b/c"]);

    expect(calls[0].url).toBe(`${FILES_ORIGIN}/files/api/articles/a%20b%2Fc`);
  });

  it("query 参数拼到 URL 上，undefined 的丢掉", async () => {
    const { fetch, calls } = spyFetch();
    await createClient({ token: "t", fetch }).agent("GET", "usage/ledger", { query: { limit: 50, before: undefined } });

    expect(calls[0].url).toBe("https://voicedrop-agent.jianshuo.workers.dev/agent/usage/ledger?limit=50");
  });

  it("2xx 返回解析后的 JSON", async () => {
    const { fetch } = spyFetch(() => json({ scope: "users/anon-1/" }));
    const out = await createClient({ token: "t", fetch }).files("GET", "whoami");

    expect(out).toEqual({ scope: "users/anon-1/" });
  });

  it("非 JSON 的 2xx 响应回文本", async () => {
    const { fetch } = spyFetch(() => new Response("queued", { status: 202 }));
    const out = await createClient({ token: "t", fetch }).agent("POST", "mine/trigger");

    expect(out).toBe("queued");
  });
});

describe("错误映射：把上游状态码翻译成人能读、模型能自救的话", () => {
  const call = async (responder) => {
    const { fetch } = spyFetch(responder);
    return createClient({ token: "t", fetch })
      .files("GET", "articles")
      .then(() => null, (e) => e);
  };

  it("401 → 说清楚 token 无效，并指出去哪拿", async () => {
    const e = await call(() => json({ error: "unauthorized" }, 401));

    expect(e.message).toContain("token");
    expect(e.message).toMatch(/App|登录/);
  });

  it("403 needs_apple_signin → 告诉用户去 App 里用 Apple 登录", async () => {
    const e = await call(() => json({ error: "needs_apple_signin" }, 403));

    expect(e.message).toContain("Apple");
    expect(e.message).not.toContain("needs_apple_signin"); // 别把机器码甩给模型
  });

  it("403 needs_wechat_signin → 微信登录", async () => {
    const e = await call(() => json({ error: "needs_wechat_signin" }, 403));

    expect(e.message).toContain("微信");
  });

  it("403 content_flagged → 说明内容被审核拦下", async () => {
    const e = await call(() => json({ error: "content_flagged" }, 403));

    expect(e.message).toMatch(/审核|拦/);
  });

  it("409 wechat_not_configured → 指向 App 设置里的公众号配置", async () => {
    const e = await call(() => json({ error: "wechat_not_configured" }, 409));

    expect(e.message).toContain("公众号");
  });

  it("404 → 说明没找到，并提示 stem 可能写错", async () => {
    const e = await call(() => json({ error: "not found" }, 404));

    expect(e.message).toMatch(/不存在|没找到/);
  });

  it("没有专门映射的错误 → 原样带上状态码和响应体，别吞掉", async () => {
    const e = await call(() => json({ error: "boom", detail: "x" }, 500));

    expect(e.message).toContain("500");
    expect(e.message).toContain("boom");
  });
});
