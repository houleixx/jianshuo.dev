// test/prompt-share-landing.test.js — /voicedrop/<7位码> 指令分享落地页。
// shares/<码> 是 typed JSON（type:"prompt"）→ 渲染指令页（标题=指令名、大号码、
// 指令全文、怎么用、下载 CTA）；纯数字码查无 → 「分享已停止」404；
// 老式文章条目（纯文本 key）不受影响。
import { describe, it, expect } from "vitest";
import { onRequest, promptShareHtml } from "../../functions/voicedrop/[token].js";
import { fakeEnv } from "./fakes.js";

function ctx(token, env) {
  return { params: { token }, env, request: { url: `https://jianshuo.dev/voicedrop/${token}` }, next: () => new Response("static", { status: 404 }) };
}

const PROMPT_DOC = JSON.stringify({
  type: "prompt", sub: "anon-owner111", itemId: "voice-editor.longpress.text.rewrite.concise",
  label: "更毒舌", instruction: "把它改得更毒舌，观点不变。",
  createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z",
});

describe("promptShareHtml", () => {
  it("carries label, big code, instruction and the how-to sections", () => {
    const h = promptShareHtml("更毒舌", "4563566", "把它改得更毒舌。");
    expect(h).toContain("更毒舌");
    expect(h).toContain('class="vd-code"');
    expect(h).toContain("4563566");
    expect(h).toContain("把它改得更毒舌。");
    expect(h).toContain("怎么用");
    expect(h).toContain("长按屏幕按住说话");
    expect(h).toContain("设置 → 提示词");
    expect(h).not.toContain("占位符");
  });
  it("adds the placeholder note only when the instruction has {{…}}", () => {
    const h = promptShareHtml("更简洁", "4563566", "把第{{LINE}}行改简洁。");
    expect(h).toContain("占位符");
    expect(h).toContain("{{LINE}}");
  });
});

describe("GET /voicedrop/<code> (prompt share)", () => {
  it("renders the prompt page for a typed shares entry", async () => {
    const env = fakeEnv({ "shares/4563566": PROMPT_DOC });
    const res = await onRequest(ctx("4563566", env));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("更毒舌");
    expect(body).toContain("4563566");
    expect(body).toContain("怎么用");
    expect(body).toContain("VoiceDrop");                 // footer / CTA 在
    expect(body).toContain('name="description"');        // 分享卡片摘要
  });
  it("numeric code with no mapping → 分享已停止 404 (not static fallthrough)", async () => {
    const res = await onRequest(ctx("4563566", fakeEnv({})));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("分享已停止");
  });
  it("legacy article share entries still render as articles", async () => {
    const env = fakeEnv({
      "shares/Ab3xK9_p2Q": "users/u1/articles/x.json",
      "users/u1/articles/x.json": JSON.stringify({ schema: 3, articles: [{ title: "文章标题", body: "正文内容。" }] }),
    });
    const res = await onRequest(ctx("Ab3xK9_p2Q", env));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("文章标题");
    expect(body).not.toContain('class="vd-code"');   // 没有指令码区块（样式表里有 .vd-code 定义不算）
  });
});
