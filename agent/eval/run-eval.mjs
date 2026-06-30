import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMinePrompt, parseArticles, MINE_MODEL_DEFAULT } from "../src/miner.js";
import { runProxyChecks } from "./lib/proxy-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 优先用真实金标集 fixtures/local/（gitignore，私人数据）；没有则回退到合成 samples/。
export function loadFixtures(baseDir = join(HERE, "fixtures")) {
  const local = join(baseDir, "local");
  const dir = (existsSync(local) && readdirSync(local).some(f => f.endsWith(".json")))
    ? local : join(baseDir, "samples");
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// callModel(payload) → rawText（注入，便于测试）。
export async function runEval({ fixtures, champSystem, candSystem, callModel, model }) {
  const results = [];
  for (const fx of fixtures) {
    const runOne = async (systemPrompt) => {
      const payload = buildMinePrompt({
        transcript: fx.transcript, styleText: "", photos: fx.photos || [],
        force: false, provider: "anthropic", model, systemPrompt,
      });
      const raw = await callModel(payload);
      let articles = [];
      try { articles = parseArticles(raw); } catch { articles = []; }
      return { articles, proxy: runProxyChecks(articles, { transcript: fx.transcript }) };
    };
    results.push({
      fixtureId: fx.id,
      champion: await runOne(champSystem),
      candidate: await runOne(candSystem),
    });
  }
  return { results };
}

// ── 真实 Anthropic 调用（CLI 入口用）──
async function anthropicCallModel(payload) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺 CLAUDE_API_KEY 环境变量");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

// CLI: node eval/run-eval.mjs <candidatePromptFile> [runId]
// 冠军 = 当前 src/prompts/mine.js 的 MINE_SYSTEM；候选 = 文件内容。
if (import.meta.url === `file://${process.argv[1]}`) {
  const { MINE_SYSTEM } = await import("../src/prompts/mine.js");
  const candFile = process.argv[2];
  if (!candFile) { console.error("用法: node eval/run-eval.mjs <candidatePromptFile> [runId]"); process.exit(1); }
  const candSystem = readFileSync(candFile, "utf8");
  const runId = process.argv[3] || "run-local";
  const fixtures = loadFixtures();
  const { results } = await runEval({
    fixtures, champSystem: MINE_SYSTEM, candSystem,
    callModel: anthropicCallModel, model: MINE_MODEL_DEFAULT,
  });
  const outDir = join(HERE, "runs", runId);
  mkdirSync(join(outDir, "outputs"), { recursive: true });
  for (const r of results) {
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.champion.json`), JSON.stringify(r.champion, null, 2));
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.candidate.json`), JSON.stringify(r.candidate, null, 2));
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`✓ ${results.length} 条 fixture 已跑完，产出在 eval/runs/${runId}/`);
  const proxyFails = results.filter(r => !r.candidate.proxy.pass).map(r => r.fixtureId);
  if (proxyFails.length) console.log(`⚠️ 候选侧确定性回退: ${proxyFails.join(", ")}`);
}
