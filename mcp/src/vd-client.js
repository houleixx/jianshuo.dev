// VoiceDrop API 客户端：三个上游 + 错误翻译。
//
// MCP server 是纯代理——它不持有任何凭证，调用方的 token 原样透传上去。

// Files API 是 Pages Function，和 MCP 本身同一个 Pages 项目。
export const FILES_ORIGIN = "https://jianshuo.dev";

// Agent worker 必须走 workers.dev 子域：同 zone 的 jianshuo.dev/agent/* 会先
// 撞上 Pages 路由，POST 被 405 掉。functions/files/api/[[path]].js:1431 调
// mine/trigger 时踩过同一个坑，这里照它的写法。
export const AGENT_ORIGIN = "https://voicedrop-agent.jianshuo.workers.dev";

// Reco worker 同理。注意它没设 SESSION_SECRET，只认 anon_ token——Apple
// session JWT 打过去会 401，所以社区列表要有回退（见 tools.js 的 community_feed）。
export const RECO_ORIGIN = "https://voicedrop-reco.jianshuo.workers.dev";

export class VoiceDropError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "VoiceDropError";
    this.status = status;
    this.body = body;
  }
}

export function createClient({ token, fetch: fetchImpl = globalThis.fetch }) {
  async function request(origin, prefix, method, path, { body, query } = {}) {
    const segments = Array.isArray(path) ? path : String(path).split("/");
    const url = new URL(`${prefix}/${segments.map(encodeURIComponent).join("/")}`, origin);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const resp = await fetchImpl(url.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!resp.ok) throw translate(resp.status, parsed, text);
    return parsed;
  }

  return {
    files: (method, path, opts) => request(FILES_ORIGIN, "/files/api", method, path, opts),
    agent: (method, path, opts) => request(AGENT_ORIGIN, "/agent", method, path, opts),
    reco: (method, path, opts) => request(RECO_ORIGIN, "/reco", method, path, opts),
  };
}

// 上游的机器错误码 → 人话。模型看到的是这些字符串，所以每条都要说清楚
// 「发生了什么」和「怎么办」，否则它只会把机器码原样念给用户听。
const BY_CODE = {
  needs_apple_signin:
    "这个操作需要可追责身份：这个账号还没绑定过 Apple 登录。" +
    "请在 VoiceDrop App 里用 Apple 登录一次（绑定后同一个 token 直接重试即可，不用换）。",
  needs_wechat_signin:
    "这个操作需要可追责身份：这个账号还没绑定过微信登录。" +
    "请在 VoiceDrop App 里用微信登录一次（绑定后同一个 token 直接重试即可，不用换）。",
  content_flagged: "内容被审核规则拦下了，没有发布到社区。",
  wechat_not_configured:
    "这个账号还没配公众号。请在 VoiceDrop App 的设置里填上公众号的 appid 和 secret。",
  pool_exhausted: "今天的投币池已经发完了，明天再来。",
  "read-only token": "这是只读 token，只能列出和下载，不能做任何写操作。",
  insufficient_credit: "算力不够了。",
};

function translate(status, parsed, raw) {
  const code = typeof parsed === "object" && parsed ? parsed.error : undefined;

  if (code && BY_CODE[code]) return new VoiceDropError(BY_CODE[code], status, parsed);

  if (status === 401) {
    return new VoiceDropError(
      "token 无效或已过期。请在 VoiceDrop App 的设置里重新复制访问令牌，" +
        "填到 MCP 客户端的 Authorization 头里。",
      status,
      parsed,
    );
  }

  if (status === 404) {
    return new VoiceDropError(
      `不存在（404）。检查 stem / shareId 是不是写错了——先用 list_articles 确认。原始响应：${raw}`,
      status,
      parsed,
    );
  }

  return new VoiceDropError(`VoiceDrop 返回 ${status}：${raw}`, status, parsed);
}
