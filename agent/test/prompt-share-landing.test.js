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
  it("一键收进工具箱按钮：voicedrop://prompt/<码> scheme 深链", () => {
    const h = promptShareHtml("更毒舌", "4563566", "把它改得更毒舌。");
    expect(h).toContain('class="vd-import"');
    expect(h).toContain('href="voicedrop://prompt/4563566"');
    expect(h).toContain("一键收进我的工具箱");
    expect(h).toContain("先下载");   // 没装 App 的兜底引导
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
  it("prompt 社区帖（kind=prompt, 有 promptCode 无 articleKey）原地渲染指令页", async () => {
    const env = fakeEnv({
      "community/6PSHBnpL8F3s.json": JSON.stringify({
        schema: 2, shareId: "6PSHBnpL8F3s", owner: "users/anon-owner111/",
        kind: "prompt", promptCode: "4563566", author: "作者甲", firstSharedAt: 1,
      }),
      "shares/4563566": PROMPT_DOC,
    });
    const res = await onRequest(ctx("6PSHBnpL8F3s", env));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("更毒舌");
    expect(body).toContain("把它改得更毒舌，观点不变。");
    // 页面上展示/口播的分享码必须是 7 位码，不是 12 位社区帖 id
    expect(body).toContain('class="vd-code"');
    expect(body).toContain("4563566");
    expect(body).not.toContain(">6PSHBnpL8F3s<");
    expect(body).toContain("怎么用");
  });
  it("被举报下架的 prompt 社区帖 → 已不可用 404（Apple 1.2，不因 shares 副本仍在而漏出）", async () => {
    const env = fakeEnv({
      "community/6PSHBnpL8F3s.json": JSON.stringify({
        schema: 2, shareId: "6PSHBnpL8F3s", owner: "users/anon-owner111/",
        kind: "prompt", promptCode: "4563566",
      }),
      "community/reports/6PSHBnpL8F3s.json": JSON.stringify({ reported: true }),
      "shares/4563566": PROMPT_DOC,
    });
    const res = await onRequest(ctx("6PSHBnpL8F3s", env));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("已不可用");
  });
  it("prompt 社区帖的 shares 副本已消失（码被关闭）→ 分享已停止 404", async () => {
    const env = fakeEnv({
      "community/6PSHBnpL8F3s.json": JSON.stringify({
        schema: 2, shareId: "6PSHBnpL8F3s", owner: "users/anon-owner111/",
        kind: "prompt", promptCode: "4563566",
      }),
    });
    const res = await onRequest(ctx("6PSHBnpL8F3s", env));
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
