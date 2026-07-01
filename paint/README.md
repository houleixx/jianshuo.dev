# paint.jianshuo.dev

Codex 订阅版 gpt-image-2 图片服务：网页手动用 + HTTP API（异步 + webhook 回调）给 skill 调。
设计 spec: `docs/superpowers/specs/2026-07-01-paint-jianshuo-dev-image-service-design.md`

## 本地开发
- `npm install && npm test`
- 跑起来（打桩 CLI，不花额度）：见 spec / plan Task 9 Step 3。

## 部署（Tokyo VPS 66.42.45.128）
- 首次：`deploy/provision.sh`（VPS 上 root），然后按提示放 `.env` / `auth.json` / Caddy 密码。
- 更新：本地 `./deploy.sh`。
- 排查：`ssh root@66.42.45.128 'journalctl -u paint -n 50 --no-pager'`

## API
- `POST /api/jobs`（`Authorization: Bearer <API_TOKEN>`）：`{prompt, image_url?|image_b64?, size?, format?, quality?, transparent?, callback_url?, callback_token?, callback_meta?}` → `202 {job_id}`
- `GET /api/jobs/:id` 轮询；`GET /api/jobs/:id/events` SSE。
- 回调：出图后 POST `callback_url`，body `{job_id,status,result_url,callback_meta,...}`，头带 `X-Paint-Signature`(HMAC) 与可选 `Authorization: Bearer <callback_token>`。
