// VoiceDrop 的远程 MCP 端点。
//
//   voicedrop.cn/mcp            ← 备案接入点的 Caddy 会补上 /voicedrop 前缀
//   jianshuo.dev/voicedrop/mcp  ← 同一个东西
//
// 真正的实现在 mcp/ 里（有自己的 package.json 和 83 个测试）。这里只是把 Pages
// 的 Request 递进去——薄到没有逻辑可出错。
//
// 放在 Pages Function 而不是 agent worker，是因为 Caddy 只把 /files/* 原样透传，
// 其余路径一律补 /voicedrop 前缀打到 Pages。所以只有落在 Pages 的 /voicedrop/mcp
// 才能让 voicedrop.cn/mcp 直接可用，不必上腾讯云那台机器改配置。

import { handleRequest } from "../../mcp/src/http.js";

export const onRequest = ({ request }) => handleRequest(request);
