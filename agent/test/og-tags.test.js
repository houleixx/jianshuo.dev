// Share-card meta tags for the public /voicedrop/<id> page — the title/description/
// image a WeChat (or X) crawler reads when the link is shared. Contract:
//   - title is SECTION-AWARE: ?s=<i> selects article i, and its title flows into
//     BOTH <title> and og:title (the bug to guard against: s=1/s=2 showing s=0's title).
//   - description = a plain-text excerpt of THAT section's body, emitted as
//     <meta name="description"> (WeChat reads this) AND og:description.
//   - og:image = THIS section's FIRST referenced photo as an ABSOLUTE url, only when
//     one exists. Each article carries its own image (no recycled banner); photo-less
//     articles stay a plain text card with no og:image.
import { describe, it, expect } from "vitest";
import { onRequest, metaTags } from "../../functions/voicedrop/[token].js";
import { fakeEnv } from "./fakes.js";

const TWO_SECTIONS = {
  schema: 3,
  articles: [
    { title: "第一篇标题", body: "第一篇的正文内容，足够长用来生成摘要。" },
    {
      title: "第二篇标题",
      body: "第二篇正文，里面带一张照片。\n\n[[photo:photos/2026-06-28-120000/3-abc.jpg]]\n\n照片后面还有一段文字。",
    },
  ],
};

function ctx(token, env, query = "") {
  return {
    params: { token },
    env,
    request: { url: `https://jianshuo.dev/voicedrop/${token}${query}` },
  };
}

function seeded() {
  return fakeEnv({
    "shares/Ab3xK9_p2Q": "users/u1/articles/VoiceDrop-x.json",
    "users/u1/articles/VoiceDrop-x.json": JSON.stringify(TWO_SECTIONS),
  });
}

describe("metaTags — WeChat / OG / Twitter share card", () => {
  it("always emits <meta name=description> (WeChat reads this, not og:description)", () => {
    const out = metaTags("标题", { description: "一段摘要", url: "https://x/" });
    expect(out).toContain('<meta name="description" content="一段摘要"/>');
    expect(out).toContain('<meta property="og:description" content="一段摘要"/>');
  });

  it("with an image → og:image + twitter large-image card + image_src", () => {
    const out = metaTags("标题", { description: "摘要", url: "https://x/", image: "https://h/p.jpg" });
    expect(out).toContain('<meta property="og:image" content="https://h/p.jpg"/>');
    expect(out).toContain('<meta name="twitter:image" content="https://h/p.jpg"/>');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image"/>');
    expect(out).toContain('<link rel="image_src" href="https://h/p.jpg"/>');
  });

  it("without an image → no og:image, plain summary card", () => {
    const out = metaTags("标题", { description: "摘要", url: "https://x/" });
    expect(out).not.toContain("og:image");
    expect(out).toContain('<meta name="twitter:card" content="summary"/>');
  });

  it("emits the Smart App Banner with the share url as app-argument", () => {
    const out = metaTags("标题", { description: "摘要", url: "https://voicedrop.cn/Ab3xK9_p2Q" });
    expect(out).toContain(
      '<meta name="apple-itunes-app" content="app-id=6781565141, app-argument=https://voicedrop.cn/Ab3xK9_p2Q"/>',
    );
  });

  it("escapes quotes in title/description into attributes", () => {
    const out = metaTags('引"号"', { description: 'a"b', url: "https://x/" });
    expect(out).toContain('<meta property="og:title" content="引&quot;号&quot;"/>');
    expect(out).toContain('<meta name="description" content="a&quot;b"/>');
  });
});

describe("onRequest — section-aware card (the s=1/s=2 title contract)", () => {
  it("?s=1 → both <title> and og:title are the SECOND section's title", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", seeded(), "?s=1"));
    const body = await res.text();
    expect(body).toContain("<title>第二篇标题</title>");
    expect(body).toContain('<meta property="og:title" content="第二篇标题"/>');
    // not the first section's title
    expect(body).not.toContain('<meta property="og:title" content="第一篇标题"/>');
  });

  it("?s=1 → og:image is the section's OWN photo, absolute url", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", seeded(), "?s=1"));
    const body = await res.text();
    expect(body).toContain(
      '<meta property="og:image" content="https://jianshuo.dev/files/api/photo/users/u1/photos/2026-06-28-120000/3-abc.jpg"/>',
    );
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  });

  it("?s=0 (photo-less section) → correct title, no og:image", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", seeded(), "?s=0"));
    const body = await res.text();
    expect(body).toContain('<meta property="og:title" content="第一篇标题"/>');
    expect(body).not.toContain("og:image");
  });

  it("description is a plain-text excerpt of the SELECTED section (markers stripped)", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", seeded(), "?s=1"));
    const body = await res.text();
    expect(body).toContain('<meta name="description" content="第二篇正文，里面带一张照片。');
    expect(body).not.toContain("[[photo:");
  });
});

// A VD社区 post reuses the SAME public page — it resolves by its community shareId
// (community/<id>.json, a schema-2 live pointer) instead of shares/<id>, then renders
// + emits og tags identically. So a 社区 post shares to WeChat exactly like an article:
// first photo + description, no separate page.
describe("onRequest — VD社区 post via community/<shareId> (same page, same card)", () => {
  function seededCommunity(extra = {}) {
    return fakeEnv({
      "community/Cm12shareId00.json": JSON.stringify({
        schema: 2, shareId: "Cm12shareId00", owner: "users/u9/",
        articleKey: "users/u9/articles/VoiceDrop-c.json", author: "阿珍", firstSharedAt: 1,
      }),
      "users/u9/articles/VoiceDrop-c.json": JSON.stringify(TWO_SECTIONS),
      ...extra,
    });
  }

  it("renders a community post by its shareId, with the SAME og:image + description", async () => {
    const res = await onRequest(ctx("Cm12shareId00", seededCommunity(), "?s=1"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>第二篇标题</title>");
    expect(body).toContain('<meta property="og:title" content="第二篇标题"/>');
    expect(body).toContain(
      '<meta property="og:image" content="https://jianshuo.dev/files/api/photo/users/u9/photos/2026-06-28-120000/3-abc.jpg"/>',
    );
    expect(body).toContain('<meta name="description" content="第二篇正文，里面带一张照片。');
  });

  it("a reported (taken-down) community post is NOT publicly viewable (Apple 1.2)", async () => {
    const env = seededCommunity({
      "community/reports/Cm12shareId00.json": JSON.stringify({ shareId: "Cm12shareId00", status: "pending" }),
    });
    const res = await onRequest(ctx("Cm12shareId00", env, ""));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("已不可用");
  });
});
