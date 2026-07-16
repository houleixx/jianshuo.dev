// src/prompt-routes.js — /agent/prompts* 的 HTTP 外壳（纯逻辑在 prompts.js，存储在 prompt-store.js）。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 存储：users/<sub>/prompts.json = { schema:1, items:[…] }（ref 或实体，两级封顶）。
// 【没有这个文件 = 全跟随模板】——GET 绝不为新用户落盘，否则就把他冻结了。
//
// 写操作只有【整树 PUT】：新建/删除/改名/改词/排序/分组/fork 全走它。客户端本来就
// 整棵树拿在手里，所以不存在局部更新竞态。
import { loadPromptTemplate } from "./prompt-template.js";
import { resolveList, validateList, restoreDefaults, sanitizeStoredItems, preserveImportMarkers, MAX_LABEL, MAX_PROMPT } from "./prompts.js";
import { loadUserPrompts, saveUserPrompts } from "./prompt-store.js";
import { resolvePromptShare, refreshPromptShare, shareStates, rekeyForkedShares } from "./prompt-share.js";

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const resolved = (tpl, items) => J({ schema: 1, items: resolveList(tpl, { schema: 1, items }) });

// ── 保存后同步分享副本（write-through on save）─────────────────────────────────
// 老模型（ui-config-custom.js）在每次 PUT 都调 refreshPromptShare 同步分享副本；
// 新模型的整树 PUT 起初没有接这条线，导致作者编辑一条正在分享的提示词后，
// 分享副本（shares/<码>）停在铸码/上次刷新时的旧版本，直到读者兑换时都看不到最新内容。
//
// 树宽收集这次 PUT 里出现的全部 id（顶层 + group 的 children；ref 用 .ref，实体用 .id）——
// 用来判断"这次保存动了哪些条目"，只刷新与之重合、且当前正处于分享中的那些。
function collectSavedIds(items) {
  const ids = new Set();
  const visit = (list) => {
    for (const n of list || []) {
      if (!n || typeof n !== "object" || Array.isArray(n)) continue;
      if (typeof n.ref === "string") ids.add(n.ref);
      if (typeof n.id === "string") ids.add(n.id);
      if (Array.isArray(n.children)) visit(n.children);
    }
  };
  visit(items);
  return ids;
}

// best-effort：绝不能让分享副本同步失败拖垮 PUT 本身（保存已经成功落盘）。
// 没有任何分享的用户（绝大多数）只产生 shareStates 内部那一次 owner 索引 GET，
// 不会因为这次 PUT 里有多少条目而多读一次 R2——shareStates 只在 byItem 非空
// 时才逐条 head 判断是否仍在分享中，空索引直接返回空表。
async function syncActiveShares(env, scope, items) {
  try {
    const states = await shareStates(env, scope);
    const activeIds = Object.entries(states).filter(([, s]) => s.sharing).map(([id]) => id);
    if (!activeIds.length) return;
    const saved = collectSavedIds(items);
    for (const id of activeIds) {
      if (saved.has(id)) await refreshPromptShare(env, scope, id);
    }
  } catch (e) { console.error("[prompts] syncActiveShares failed:", e && e.message); }
}

export async function handlePromptsRoute(request, env, scope, url) {
  const tpl = await loadPromptTemplate(env);

  // POST /agent/prompts/restore-defaults —— 补回模板里缺的（后悔药 + 拿新 prompt）
  if (url.pathname === "/agent/prompts/restore-defaults") {
    if (request.method !== "POST") return J({ error: "method not allowed" }, 405);
    const doc = await loadUserPrompts(env, scope);
    // 还没有自己的文件 = 本来就全跟随模板，恢复默认是 no-op，也不落盘。
    if (!doc) return J({ schema: 1, items: resolveList(tpl, null) });
    // 先清洗：doc.items 可能带着垃圾节点，或者模板热更后已经退休的悬空 ref
    // （config/prompt-template.json 是可实时调优的，sys_* 消失是合法运营动作，
    // 不该让还持有那条 ref 的用户在这个端点上永远 400/500——resolveList 读路径
    // 早就对悬空 ref 静默丢弃了，写路径必须待遇一致）。restoreDefaults 自己的
    // cloneTop 不认模板，不清悬空 ref，所以这一步不能省。
    const sanitized = sanitizeStoredItems(doc.items, tpl);
    const next = restoreDefaults(tpl, sanitized);
    // 防御性纵深：restoreDefaults 的输出理论上总能过 validateList，但这个端点会落盘——
    // 绝不允许一份没过校验的文档被写进 R2。校验失败就当没发生过（不落盘），报 500
    // 好过悄悄写坏数据；这条分支不该被真实触发，触发了就是 restoreDefaults 自己的 bug。
    const err = validateList(tpl, next);
    if (err) {
      console.error("[prompts] restoreDefaults produced invalid list:", err);
      return J({ error: "internal error: restore-defaults produced an invalid list" }, 500);
    }
    await saveUserPrompts(env, scope, next);
    return resolved(tpl, next);
  }

  if (request.method === "GET") {
    const doc = await loadUserPrompts(env, scope);
    return J({ schema: 1, items: resolveList(tpl, doc) });   // doc=null → 模板全量，【不落盘】
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.items)) {
      return J({ error: "expected {items: [...]}" }, 400);
    }
    // 老客户端没建模 importedFrom，会在整树 PUT 里把导入标记剥掉——按 id 从旧文档
    // 补回（见 prompts.js#preserveImportMarkers）。补回值出自 IMPORT_CODE_RE 白名单，
    // 不可能把一份本来合法的 PUT 变成 400，所以放在 validateList 之前是安全的。
    const prev = await loadUserPrompts(env, scope);
    if (prev && Array.isArray(prev.items)) preserveImportMarkers(prev.items, body.items);
    const err = validateList(tpl, body.items);
    if (err) return J({ error: err }, 400);
    await saveUserPrompts(env, scope, body.items);
    // re-key 必须先于活同步：fork 一个正在分享的系统项后，索引键要从旧 id（sys_*）
    // 挪到新的实体 id，紧接着的 syncActiveShares 才能认出这个实体正处于分享中，
    // 把 fork 后的新内容刷进 shares/<码>——否则分享码会永远冻结在 fork 前的旧内容。
    // 也是 best-effort（函数内部已经 try/catch），见 prompt-share.js#rekeyForkedShares。
    await rekeyForkedShares(env, scope, body.items);
    await syncActiveShares(env, scope, body.items);   // best-effort, 见上方注释
    return resolved(tpl, body.items);
  }

  return J({ error: "method not allowed" }, 405);
}

// ── POST /agent/prompts/import — 魔法数字导入成自建副本 ─────────────────────────
// spec §8：导入 = 独立实体副本（origin:user，无 forkedFrom）——它不是从系统模板
// fork 的，原作者之后再改这条指令，【不会影响已经导入过的人】；可改名/改词/删。

/// 新实体 id：p_ + 8 位 base36。客户端也生成同格式的 id（validateList 校验格式）。
function newUserId() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return "p_" + (a[0].toString(36) + a[1].toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 8).padEnd(8, "0");
}

/// 树宽收集 items 里已经用掉的实体 id（顶层 + group 的 children，垃圾节点已经在
/// materialize 阶段被 sanitizeStoredItems 清掉，这里不用再防）。用来给 newUserId
/// 撞车让路——理论上 2×32 位随机源撞车概率极低，但"理论上极低"不等于"不用处理"：
/// 撞了就该悄悄重摇一个新 id，而不是让 validateList 的 duplicate id 检查把整次
/// 导入判成 400（那样用户会遇到一个自己完全没法理解、也无法自己修复的错误）。
/// 树宽收集全部 action 实体节点（顶层 + group children；ref 不算——它们身上
/// 不可能有 importedFrom）。返回的是 items 里的原对象引用，调用方可原地打标记。
function collectEntityActions(items) {
  const out = [];
  const visit = (list) => {
    for (const n of list || []) {
      if (!n || typeof n !== "object" || Array.isArray(n)) continue;
      if (Array.isArray(n.children)) visit(n.children);
      if (!n.ref && n.type === "action") out.push(n);
    }
  };
  visit(items);
  return out;
}

function collectEntityIds(items) {
  const ids = new Set();
  const visit = (list) => {
    for (const n of list || []) {
      if (n && typeof n === "object" && !Array.isArray(n)) {
        if (n.id) ids.add(n.id);
        if (Array.isArray(n.children)) visit(n.children);
      }
    }
  };
  visit(items);
  return ids;
}

/// 撞见已占用的 id 就重摇，摇够多次还撞（几乎不可能）就直接返回最后一个——
/// 让 validateList 兜底拒收，好过在这里死循环。
function freshUserId(usedIds) {
  for (let i = 0; i < 10; i++) {
    const id = newUserId();
    if (!usedIds.has(id)) return id;
  }
  return newUserId();
}

/// 截断到最多 max 个 UTF-16 code unit——这必须跟 validateList 的计数口径一致
/// （它用 .length，即 UTF-16 code unit 数，不是 code point 数），所以不能换成
/// 数 code point 再截：那样会吐出一份自己都过不了 validateList 上限检查的字符串。
/// 唯一的陷阱：截断点如果正好落在一个代理对（surrogate pair，如 emoji）中间，
/// 会切出一个孤立的高位代理（\uD800-\uDBFF），下游拿去用会变成半个字符的乱码——
/// 截完之后多看一步，孤立的高位代理整个丢掉（不补半个回来会超上限，留着半个是
/// mojibake，两头都不对，唯一选择是丢）。
function truncateUtf16(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xD800 && last <= 0xDBFF) ? cut.slice(0, -1) : cut;
}

/// 把「当前生效的列表」物化成一份【用户列表】（存储原始形状：ref / 实体，不是解析结果）。
/// 用户还没有 prompts.json 时，他的生效列表 = 模板全量 → 物化成全 ref——这样模板项
/// 仍然跟随最新，只是现在显式列在他的文件里了。【关键陷阱】：物化出的 group ref
/// 必须显式列出 children，否则 resolveList 会把没有 children 这个 key 的 group ref
/// 解析成空组，等于把组里的每一条系统 prompt 都从用户菜单里丢了。
///
/// 用户已经有 prompts.json 时，不能把 doc.items 原样拿来用——它可能带着老版本
/// 代码或存储层损坏留下的垃圾节点（resolveList/restoreDefaults 都容忍这类垃圾，
/// 但 validateList 零容忍），必须先用 sanitizeStoredItems 清洗一遍，否则用户自己
/// 早就有的、跟这次导入毫无关系的垃圾会把这次导入也一起拖成 400。
function materialize(tpl, doc) {
  if (doc && Array.isArray(doc.items)) return sanitizeStoredItems(doc.items, tpl);
  return (tpl.items || []).map((t) => (t.type === "group"
    ? { ref: t.id, children: (t.children || []).map((c) => ({ ref: c.id })) }
    : { ref: t.id }));
}

/// POST /agent/prompts/import {code} —— 导入 = 独立自建副本（origin:user，无 forkedFrom）。
/// 原作者之后的修改【不影响你】——这正是它区别于 ref 的地方。
export async function handlePromptImport(request, env, scope) {
  if (request.method !== "POST") return J({ error: "method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim();
  if (!/^[1-9][0-9]{6}$/.test(code)) return J({ error: "expected {code}" }, 400);

  const hit = await resolvePromptShare(env, code);
  if (!hit) return J({ error: "not-found" }, 404);

  const tpl = await loadPromptTemplate(env);
  const doc = await loadUserPrompts(env, scope);
  const items = materialize(tpl, doc);

  // label/instruction 的上限本该在铸码/保存时就已经守住（MAX_LABEL/MAX_PROMPT ==
  // 分享侧的 maxLength 默认值），但分享文档是【外部写入的既成事实】——旧码、被
  // 后台配置改过上限之后铸的码、或者存储层被手改，都可能带来一份超限的内容。
  // 这里选择【截断】而不是 400：截断只是丢掉尾巴，用户导入后是自己独立可编辑的
  // 副本，能立刻看到、立刻改；400 则是把"别人分享的内容超限"这个跟当前导入者
  // 毫无关系的历史问题，变成"你这条永远导不进来"——对导入者不公平，也没有他能
  // 采取的补救动作。label/instruction 两者用同一策略，保持行为一致。截断用
  // truncateUtf16（不是裸 .slice）——纯 .slice 可能正好切断一个代理对（emoji），
  // 留下半个字符的乱码。
  //
  // label 的空判断必须用 trim 后是否为空，不能只判 falsy：hit.label 是纯空白
  // （比如 "     "，构造分享文档时手改/老数据留下的）时 falsy 判断挡不住——
  // truthy 的空白字符串会原样流进 item.label，喂给 validateList 的
  // "label must not be empty"（它按 trim 判空）直接 400，违背了本函数
  // "截断不拒绝" 的设计初衷。
  const rawLabel = typeof hit.label === "string" ? hit.label : "";
  const label = truncateUtf16(rawLabel.trim() ? rawLabel : "导入的提示词", MAX_LABEL);
  const prompt = truncateUtf16(String(hit.instruction || ""), MAX_PROMPT);

  // ── 幂等：反复收下同一个码，不重复添加（2026-07-16 用户拍板）───────────────
  // 识别键 = 实体上的 importedFrom（本端点落盘时打上）。存量老副本没有这个标记，
  // 退一步按内容认领（label+prompt 与本次导入的计算结果完全一致、且自己没有别的
  // importedFrom）——认领时顺手补上标记，下次直接按码命中。用户删掉那条 = id 从树里
  // 消失，再导入照常追加（这正是「删了还能再收」的语义）。
  const entities = collectEntityActions(items);
  let existing = entities.find((n) => n.importedFrom === code);
  if (!existing) {
    const legacy = entities.find((n) => n.importedFrom === undefined && n.label === label && n.prompt === prompt);
    if (legacy) {
      legacy.importedFrom = code;
      // 补标记是锦上添花：清洗过的树 + 白名单格式的码，validateList 理应通过；
      // 万一不过（存量脏数据的极端形状），放弃落盘也不影响本次「已收下」的判定。
      if (!validateList(tpl, items)) await saveUserPrompts(env, scope, items);
      existing = legacy;
    }
  }
  if (existing) {
    const flat = [];
    for (const it of resolveList(tpl, { schema: 1, items })) {
      flat.push(it);
      if (Array.isArray(it.children)) flat.push(...it.children);
    }
    return J({ item: flat.find((i) => i.id === existing.id), already: true });
  }

  const item = {
    id: freshUserId(collectEntityIds(items)), type: "action",
    label, prompt,
    appliesTo: hit.appliesTo,
    ...(hit.kind !== undefined ? { kind: hit.kind } : {}),
    importedFrom: code,
  };
  items.push(item);

  const err = validateList(tpl, items);
  if (err) return J({ error: err }, 400);
  await saveUserPrompts(env, scope, items);

  // importCount +1 —— best-effort。R2 没有原子自增，并发导入偶尔丢计数（虚荣数字，
  // spec §8 已接受）。失败不影响导入本身：导入已经落盘了，回写计数只是锦上添花。
  try {
    const obj = await env.FILES.get(`shares/${code}`);
    if (obj) {
      const share = JSON.parse(await obj.text());
      share.importCount = (share.importCount || 0) + 1;
      await env.FILES.put(`shares/${code}`, JSON.stringify(share, null, 2));
    }
  } catch (e) { console.error("[prompts] importCount bump failed:", e && e.message); }

  const resolvedItems = resolveList(tpl, { schema: 1, items });
  return J({ item: resolvedItems[resolvedItems.length - 1] });
}
