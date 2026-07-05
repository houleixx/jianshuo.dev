import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE = resolve("test/fixtures/fake-codex.mjs");

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "codex-agent-"));
  process.env.CODEX_BIN = process.execPath; // node
  process.env.CODEX_ARGS_PREFIX = FAKE; // 见 server.ts：测试注入桩脚本
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.WORKSPACE = dir;
  const { createApp } = await import("../src/server.ts");
  const app = createApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base };
}

/** 读整条 SSE 流，返回 [{event,data}] */
async function sseAll(res: Response) {
  const text = await res.text();
  const out: { event: string; data: any }[] = [];
  for (const chunk of text.split("\n\n")) {
    const ev = chunk.match(/^event: (.+)$/m)?.[1];
    const data = chunk.match(/^data: (.+)$/m)?.[1];
    if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

function post(base: string, body: unknown) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("新会话：chat(chatId) 先发，text 回声，done 收尾", async () => {
  const { app, base } = await boot();
  const evs = await sseAll(await post(base, { message: "你好" }));
  assert.equal(evs[0].event, "chat");
  assert.ok(evs[0].data.chatId);
  assert.equal(evs.find((e) => e.event === "text")?.data.text, "echo: 你好");
  assert.equal(evs.at(-1)?.event, "done");
  app.close();
});

test("续聊：同 chatId 第二条消息走 resume（回声带 resumed:<threadId>）", async () => {
  const { app, base } = await boot();
  const chatId = (await sseAll(await post(base, { message: "第一句" })))[0].data.chatId;
  const evs = await sseAll(await post(base, { chatId, message: "第二句" }));
  const txt = evs.find((e) => e.event === "text");
  assert.ok(txt?.data.text.startsWith("resumed:t-fake-0001"), `got: ${txt?.data.text}`);
  app.close();
});

test("并发闸：第二个请求先收到 queued，最终也完成", async () => {
  const { app, base } = await boot();
  const p1 = post(base, { message: "SLOW 一号" });
  await new Promise((r) => setTimeout(r, 80)); // 确保一号先占住
  const p2 = post(base, { message: "二号" });
  const [e1, e2] = await Promise.all([p1.then(sseAll), p2.then(sseAll)]);
  assert.ok(e1.some((e) => e.event === "text"));
  assert.ok(e2.some((e) => e.event === "queued"), "二号应先排队");
  assert.ok(e2.some((e) => e.event === "text" && e.data.text === "echo: 二号"));
  app.close();
});

test("codex 失败：error 事件，仍 done 收尾", async () => {
  const { app, base } = await boot();
  const evs = await sseAll(await post(base, { message: "FAIL 掉" }));
  assert.ok(evs.some((e) => e.event === "error"));
  assert.equal(evs.at(-1)?.event, "done");
  app.close();
});
