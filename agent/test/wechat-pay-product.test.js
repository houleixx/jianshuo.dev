import { describe, expect, it } from "vitest";
import { handleWechatPayProductRoute } from "../src/wechat-pay-product.js";

function call(origin = "https://voicedrop.cn", path = "/agent/wechat-pay/product", method = "GET") {
  const url = new URL(path, origin);
  return handleWechatPayProductRoute(url, new Request(url, { method }));
}

describe("public WeChat subscription product page", () => {
  it("serves the complete offer without login, payment credentials or storage", async () => {
    const response = call();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("19.9");
    expect(html).toContain("每期 200 算力");
    expect(html).toContain("第 3 个北京时间自然日凌晨 02:00");
    expect(html).toContain("解除自动续费");
    expect(html).toContain("mailto:jianshuo@hotmail.com");
    expect(html).not.toContain("<script");
  });

  it("supports the test Worker domain and trailing slash with identical content", async () => {
    const production = await call().text();
    const test = await call("https://voicedrop-agent-test.houleixx.workers.dev").text();
    expect(test).toBe(production);
    expect(await call("https://voicedrop.cn", "/agent/wechat-pay/product/").text()).toBe(production);
  });

  it("answers HEAD probes with the same headers and no body", async () => {
    const head = call("https://voicedrop.cn", "/agent/wechat-pay/product", "HEAD");
    expect(head.status).toBe(200);
    expect([...head.headers]).toEqual([...call().headers]);
    expect(await head.text()).toBe("");
  });

  it("rejects mutations and leaves payment endpoints to their authenticated handlers", () => {
    const post = call("https://voicedrop.cn", "/agent/wechat-pay/product", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    for (const path of ["/agent/wechat-pay/contract", "/agent/wechat-pay/status", "/agent/wechat-pay/cancel", "/agent/wechat-pay/product/other"]) {
      expect(call("https://voicedrop.cn", path)).toBeNull();
    }
  });
});
