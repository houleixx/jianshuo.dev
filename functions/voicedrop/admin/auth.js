// /voicedrop/admin/auth — 后台准入门禁（用户白名单）。
//
// 背景：/voicedrop/admin/* 的 7 个后台页面原本让人直接粘 master token（FILES_TOKEN）
// 当凭证。现在改成「用户白名单」：人粘自己的 session token，这里校验其身份是否在
// env.ADMIN_NAMES 里，命中才把 FILES_TOKEN 交给浏览器（页面照旧用它调 Files/agent API）。
//
// 关键点：FILES_TOKEN 本身的任何功能（miner 写回、notify、各 admin API 判定）一律不动，
// 这里只是「把发 FILES_TOKEN 的口」从『你得先知道它』改成『你的身份得在白名单里』。
//
// 白名单标识 = readProfileName 产出的「作者显示名」——即用户自设的名字（如 houlei / 老6），
// 或没设名字时的兜底 ID 码（scope 前 6 位大写，如 AE209A，不可被用户篡改）。二者取其一命中即可。
// 安全注记：名字是用户可自设字段，理论上可被冒充；ID 码不可改、更稳。名单尽量用 ID 码。
//
// 白名单来源：env.ADMIN_NAMES —— 逗号 / 空白 / 换行分隔，如 "houlei, 老6, AE209A"。
// 未命中时 403 回显你的 name / code / scope，方便照抄进 ADMIN_NAMES 完成 bootstrap。

import { verifySession } from "../../lib/auth.js";
import { readProfileName } from "../../lib/style-store.js";

function parseList(raw) {
  const set = new Set();
  for (let s of String(raw || "").split(/[\s,]+/)) {
    s = s.trim();
    if (s) set.add(s);
  }
  return set;
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

  // 显示名（未设名字则空）+ 稳定 ID 码。名单里任一命中即放行。
  let name = "";
  try {
    name = await readProfileName(env, scope, { fallback: "none" });
  } catch {
    name = "";
  }
  const code = idCode(scope);

  const list = parseList(env.ADMIN_NAMES);
  const hit =
    (name && list.has(name.trim())) ||
    [...list].some((e) => e.toUpperCase() === code); // ID 码大小写不敏感

  if (!hit) {
    // 回显身份方便加进 ADMIN_NAMES（bootstrap）。不泄露 FILES_TOKEN。
    return J({ error: "not in allowlist", name: name || null, code, scope }, 403);
  }

  if (!env.FILES_TOKEN) return J({ error: "server misconfigured" }, 500);
  return J({ ft: env.FILES_TOKEN, name: name || null, code, scope });
}
