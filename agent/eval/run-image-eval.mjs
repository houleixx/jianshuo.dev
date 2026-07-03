// image-only 挖矿 eval：champion = 现行 IMAGE_ONLY_SYSTEM 单发；candidate = 四阶段流水线。
// fixture 结构：{ id, stem, photos:[{b64,label,relKey}], styleText?, recentTitles?[] }
// 真实金标放 eval/fixtures/image-local/（gitignore，私人照片数据）；合成样例在 image-samples/。
// 用法：CLAUDE_API_KEY=… node eval/run-image-eval.mjs <runId>
// 判定：proxy 全过之后，用 /wjs-evaling-voicedrop-prompts 的盲评流程对 outputs 打分。
// 通过标准（spec §6）：candidate 胜率 ≥ 60% 且编造项零回归 → config/model.json 置 imagePipeline:true。
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMinePrompt, parseArticles, MINE_MODEL_DEFAULT } from "../src/miner.js";
import { IMAGE_ONLY_SYSTEM } from "../src/prompts/mine.js";
import { runImagePipeline, parsePlaceTag, parseSessionInfo } from "../src/image-mine.js";
import { runImageProxyChecks } from "./lib/image-proxy-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadImageFixtures(baseDir = join(HERE, "fixtures")) {
  const local = join(baseDir, "image-local");
  const dir = (existsSync(local) && readdirSync(local).some((f) => f.endsWith(".json")))
    ? local : join(baseDir, "image-samples");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function runImageEval({ fixtures, callModel, model }) {
  const results = [];
  for (const fx of fixtures) {
    const photoKeys = fx.photos.map((p) => p.relKey);
    const factPack = {
      place: parsePlaceTag(fx.stem),
      session: parseSessionInfo(fx.stem),
      photos: fx.photos.map((p) => ({ key: p.relKey, time: p.label })),
      recentTitles: fx.recentTitles || [],
    };
    // champion：与生产 mineVariant 的 image-only 调用同参（single 一发）
    const champion = { articles: [] };
    try {
      const payload = buildMinePrompt({
        transcript: "", styleText: fx.styleText || "", photos: fx.photos, force: false,
        provider: "anthropic", model, systemPrompt: IMAGE_ONLY_SYSTEM, photoInstr: "",
      });
      champion.articles = parseArticles(await callModel({ stage: "single", payload }));
    } catch (e) { champion.error = String(e); }
    // candidate：四阶段流水线
    let candidate = { articles: [] };
    try {
      candidate = await runImagePipeline({
        photos: fx.photos, factPack, styleText: fx.styleText || "", model, callModel,
      });
    } catch (e) { candidate = { articles: [], error: String(e) }; }
    results.push({
      fixtureId: fx.id,
      champion: { ...champion, proxy: runImageProxyChecks(champion.articles, { photoKeys }) },
      candidate: { ...candidate, proxy: runImageProxyChecks(candidate.articles, { photoKeys }) },
    });
  }
  return { results };
}

async function anthropicCallModel({ payload }) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺 CLAUDE_API_KEY 环境变量");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runId = process.argv[2] || "image-run-local";
  const fixtures = loadImageFixtures();
  const { results } = await runImageEval({ fixtures, callModel: anthropicCallModel, model: MINE_MODEL_DEFAULT });
  const outDir = join(HERE, "runs", runId);
  mkdirSync(join(outDir, "outputs"), { recursive: true });
  for (const r of results) {
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.champion.json`), JSON.stringify(r.champion, null, 2));
    writeFileSync(join(outDir, "outputs", `${r.fixtureId}.candidate.json`), JSON.stringify(r.candidate, null, 2));
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`✓ ${results.length} 条 image fixture 已跑完，产出在 eval/runs/${runId}/`);
  const proxyFails = results.filter((r) => !r.candidate.proxy.pass).map((r) => r.fixtureId);
  if (proxyFails.length) console.log(`⚠️ 候选侧确定性回退: ${proxyFails.join(", ")}`);
}
