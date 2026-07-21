// /voicedrop/admin/auth — 后台准入门禁（用户白名单）。
//
// 背景：/voicedrop/admin/* 的 7 个后台页面原本让人直接粘 master token（FILES_TOKEN）
// 当凭证。现在改成「用户白名单」：人粘自己的 session token，这里校验其身份是否在
// env.ADMIN_SCOPES 里，命中才把 FILES_TOKEN 交给浏览器（页面照旧调 Files/agent API）。
//
// 关键点：FILES_TOKEN 本身的任何功能（miner 写回、notify、各 admin API 判定）一律不动，
// 这里只是「把发 FILES_TOKEN 的口」从『你得先知道它』改成『你的身份得在白名单里』。
//
// 白名单标识 = 用户的 scope（users/<sub>/）或其 6 位 ID 码（scope 前 6 位大写，如 AE209A）。
// 两者都由登录身份推导、用户不可篡改 —— 不用显示名（那是可自设字段，会被冒充）。
// env.ADMIN_SCOPES 里两种写法都认：完整 scope `users/anon-xxxx/` 或短码 `AE209A`。
//
// 未命中时 403 回显你的 scope / code / name，方便照抄进 ADMIN_SCOPES 完成 bootstrap。

import { verifySession } from "../../lib/auth.js";
import { readProfileName } from "../../lib/style-store.js";

// 把名单拆成 { scopes:Set, codes:Set }。带 users/ 或以 / 结尾 → 当 scope；否则当短码（大写）。
function parseAllowlist(raw) {
  const scopes = new Set();
  const codes = new Set();
  for (let s of String(raw || "").split(/[\s,]+/)) {
    s = s.trim();
    if (!s) continue;
    if (s.startsWith("users/") || s.endsWith("/")) {
      if (!s.endsWith("/")) s += "/";
      scopes.add(s);
    } else {
      codes.add(s.toUpperCase());
    }
  }
  return { scopes, codes };
}

// scope("users/<sub>/" 或 "users/anon-<hash>/") → 6 位大写 ID 码，同 readProfileName 的兜底。
function idCode(scope) {
  const id = String(scope || "").replace(/^users\//, "").replace(/^anon-/, "").replace(/\/+$/, "");
  return id.slice(0, 6).toUpperCase();
}

const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return J({ error: "bad request" }, 400);
  }
  const token = (body && body.token ? String(body.token) : "").trim();
  if (!token) return J({ error: "missing token" }, 400);

  if (!env.SESSION_SECRET) return J({ error: "server misconfigured" }, 500);

  // 只认真正签发过的 session（Apple / 微信登录），不认匿名 token —— admin 必须是实名身份。
  const sess = await verifySession(token, env.SESSION_SECRET);
  if (!sess || !sess.scope) return J({ error: "invalid session" }, 401);
  const scope = sess.scope;
  const code = idCode(scope);

  const { scopes, codes } = parseAllowlist(env.ADMIN_SCOPES);
  const hit = scopes.has(scope) || codes.has(code);

  if (!hit) {
    // 名字仅用于 403 回显（方便认人），不参与放行判断。
    let name = null;
    try { name = (await readProfileName(env, scope, { fallback: "none" })) || null; } catch {}
    return J({ error: "not in allowlist", scope, code, name }, 403);
  }

  if (!env.FILES_TOKEN) return J({ error: "server misconfigured" }, 500);
  return J({ ft: env.FILES_TOKEN, scope, code });
}
