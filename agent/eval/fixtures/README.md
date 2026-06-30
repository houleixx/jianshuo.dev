# 挖矿 prompt 评估 · 金标集

每个 `*.json` 是一条冻结的金标录音转写。eval 时每个 prompt 版本都跑这同一组，差异即归因到 prompt。

🔒 **隐私**：jianshuo.dev 是公开 repo。
- `samples/` —— 仅**合成/脱敏**示例，可提交，只够自测流程。
- `local/` —— 真实录音转写，**已 gitignore**，绝不进公开 repo。eval 实跑用这里的。

格式：
{ "id": "001-multi-topic", "transcript": "...口述转写...", "photos": [], "tags": ["多主题","长"] }

photos（可选）：[{ "relKey": "photos/2026-xx/xx.jpg", "label": "HH:MM:SS", "b64": "<base64>" }]

覆盖维度（攒满 10–15 条时确保各维度都有）：长/短、单主题/多主题、带图/不带、情绪/技术/日常。

补满真实数据到 local/（需用户 VoiceDrop token，交互执行；**只取文本转写，不下 mp3**）：
1. 用 wjs-voicedrop skill 列出并取若干真实录音的转写（`vd list` → transcript 文本）。
2. 每条存成 `local/<id>.json`，按内容打 tags。权威备份在 VoiceDrop/R2，本地只是可重拉快照。
3. 冻结成文件才可复现；风格漂移后再换血。
