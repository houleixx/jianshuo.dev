// 把每条 fixture 的成对裁判结论汇总成胜率与判定。
// 判定规则：候选胜率 ≥ threshold 且无确定性回退 → promote；否则 hold。
// 人工认可那一票在 skill 流程里，不在此处。
export function aggregate(verdicts, { threshold = 0.7, proxyFails = [] } = {}) {
  const wins = verdicts.filter(v => v.winner === "candidate").length;
  const losses = verdicts.filter(v => v.winner === "champion").length;
  const ties = verdicts.filter(v => v.winner === "tie").length;
  const decisiveCount = wins + losses;
  const candidateWinRate = decisiveCount === 0 ? 0 : wins / decisiveCount;
  const regressions = [...new Set(proxyFails)];
  const decision = (candidateWinRate >= threshold && regressions.length === 0) ? "promote" : "hold";
  return { candidateWinRate, decisiveCount, wins, losses, ties, regressions, decision };
}

export function renderReport(summary, { champRef = "HEAD", candRef = "working" } = {}) {
  const pct = (summary.candidateWinRate * 100).toFixed(1);
  const verdict = summary.decision === "promote" ? "✅ 建议晋级（仍需人工抽查认可）" : "⏸ 保留生产版";
  const lines = [
    `# 挖矿 prompt 评估报告`,
    ``,
    `- 冠军（生产版）：\`${champRef}\``,
    `- 候选版：\`${candRef}\``,
    `- **候选胜率：${pct}%**（decisive ${summary.decisiveCount}：胜 ${summary.wins} / 负 ${summary.losses}，平 ${summary.ties}）`,
    summary.regressions.length ? `- ⚠️ 确定性回退 fixture：${summary.regressions.join(", ")}` : `- 确定性检查：全过`,
    ``,
    `## 判定`,
    ``,
    verdict,
  ];
  return lines.join("\n");
}
