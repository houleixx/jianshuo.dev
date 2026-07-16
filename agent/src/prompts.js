// src/prompts.js — 提示词列表的纯逻辑：解析（ref→fork）/ 校验 / 恢复默认。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 用户列表里每一项只有两种形态：
//   {"ref":"sys_*"}  → 我没动过，整条读模板（模板一调优，用户立刻吃到最新）
//   完整实体          → 这条是我的，冻结
// 解析没有"合并"、没有"打补丁"——ref 是整条取模板，不是取底子再盖字段。
//
// 默认全是 ref，所以【不写 prompt 的大多数用户永远拿到最新最好的 prompt】；
// 新建/导入只是多一条实体，其余系统项仍是 ref、仍跟随（轻度触碰不冻结全局）。
import { templateIndex } from "./prompt-template.js";

/// 实体节点 → 对外的解析结果（origin 由 forkedFrom 推出）。
function fromEntity(node) {
  const out = {
    id: node.id, type: node.type, label: node.label,
    origin: node.forkedFrom ? "custom" : "user",
  };
  if (node.forkedFrom) out.forkedFrom = node.forkedFrom;
  if (node.type === "action") {
    out.prompt = node.prompt;
    out.appliesTo = Array.isArray(node.appliesTo) ? [...node.appliesTo] : node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = deepCloneParams(node.imageParams);
    if (node.importedFrom !== undefined) out.importedFrom = node.importedFrom;
  }
  return out;
}

/// 深拷贝 imageParams：值可能带嵌套对象/数组，浅拷贝（{...obj}）只保护顶层键，
/// 嵌套值仍会与源对象（尤其是模块级 DEFAULT_PROMPT_TEMPLATE，活过整个 Worker isolate）共享引用。
function deepCloneParams(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/// 模板节点 → 对外的解析结果（origin=system；children 不在这里展开）。
// 防御性拷贝 appliesTo/imageParams：DEFAULT_PROMPT_TEMPLATE 是模块级字面量，
// 活过整个 Worker isolate 的所有请求——原样引用会让某次请求手滑改了输出，
// 就此污染后面每一个请求读到的模板。
function fromTemplate(node) {
  const out = { id: node.id, type: node.type, label: node.label, origin: "system" };
  if (node.type === "action") {
    out.prompt = node.prompt;
    out.appliesTo = Array.isArray(node.appliesTo) ? [...node.appliesTo] : node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = deepCloneParams(node.imageParams);
  }
  return out;
}

/// 垃圾节点判定：不是"非空、非数组的朴素对象"就是垃圾——null / 数字 / 字符串 /
/// 布尔 / 数组都算。resolveList/restoreDefaults 读的是【已经落盘】的旧文档，
/// 可能是历史 bug、手改、或存储层损坏写进来的垃圾（语法仍是合法 JSON）；这两个
/// 函数对任意 JSON 形状必须 total（不 throw）——垃圾节点的降级路径是"跳过"，
/// 跟悬空 ref 一个待遇，不是拿它冒充数据去访问 .ref/.children 而崩成 500。
function isJunkNode(node) {
  return node === null || typeof node !== "object" || Array.isArray(node);
}

/// 一个列表节点（ref 或实体）→ 解析结果；悬空 ref（模板已删）/ 垃圾节点 → null（调用方丢掉）。
function resolveNode(node, idx) {
  if (isJunkNode(node)) return null;
  if (node.ref) {
    const t = idx.get(node.ref);
    return t ? fromTemplate(t) : null;
  }
  return fromEntity(node);
}

/// 模板全量 → 解析结果（用户还没有 prompts.json 时走这条）。
function resolveWholeTemplate(template) {
  return (template.items || []).map((item) => {
    const out = fromTemplate(item);
    if (item.type === "group") out.children = (item.children || []).map(fromTemplate);
    return out;
  });
}

export function resolveList(template, userDoc) {
  if (!userDoc || !Array.isArray(userDoc.items)) return resolveWholeTemplate(template);
  const idx = templateIndex(template);
  const out = [];
  for (const node of userDoc.items) {
    const resolved = resolveNode(node, idx);
    if (!resolved) continue;                       // 悬空 ref / 垃圾节点：跳过
    if (resolved.type === "group") {
      // resolveNode 已经把垃圾挡在前面——能走到这里，node 保证是朴素对象。
      // children 非数组（缺失 / null / 对象 / 数字…）一律当"没有 children"处理 = 空组。
      const rawChildren = Array.isArray(node.children) ? node.children : [];
      resolved.children = rawChildren
        .map((c) => resolveNode(c, idx))
        .filter(Boolean);
    }
    out.push(resolved);
  }
  return out;
}

// ── 校验（PUT /agent/prompts 的守门人）────────────────────────────────────────
export const MAX_ITEMS = 200;
export const MAX_LABEL = 40;
export const MAX_PROMPT = 4000;
export const MAX_KIND = 24;
export const MAX_IMAGE_PARAMS_KEYS = 8;
export const MAX_IMAGE_PARAM_VALUE = 40;
const USER_ID_RE = /^p_[a-z0-9]{6,}$/;
const APPLIES = new Set(["text", "image"]);

// 字段白名单（spec §3:「有 ref 就没有其他内容字段（children 除外）」）。
// 白名单外的字段一律拒绝——否则任意大小的载荷能从任何一个陌生键名混进存储。
const REF_ACTION_KEYS = new Set(["ref"]);
const REF_GROUP_KEYS = new Set(["ref", "children"]);
const ENTITY_ACTION_KEYS = new Set(["id", "type", "label", "prompt", "appliesTo", "kind", "imageParams", "forkedFrom", "importedFrom"]);
// importedFrom = 这条实体当初是从哪个 7 位分享码导入的（导入幂等的识别键：
// 「收下这条提示词」反复点，同码只落一条）。只在 action 实体上合法。
export const IMPORT_CODE_RE = /^[1-9][0-9]{6}$/;
const ENTITY_GROUP_KEYS = new Set(["id", "type", "label", "children", "forkedFrom"]);

/// kind/imageParams 只在字段白名单里对 action 放行——但白名单只挡键名，不挡值，
/// 而这两个字段是唯一没有别的上限守住的自由字段（label/prompt 各有 MAX_LABEL/
/// MAX_PROMPT）。没有值上限意味着一条已认证的 PUT 能在 200 个 item 上各挂一份
/// 巨 blob 存进去，且此后每次 GET 都要为它们付一次 resolveList/deepCloneParams
/// 的 structuredClone 代价——跟已经堵掉的"未知键名走私"是同一类滥用面。
/// 注意：kind 这里【不做枚举限制】——spec 只要求它被存储 + 原样透传，未来新出
/// 的 kind 值不能因为不在白名单里就被这个校验器 400 掉。
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/// imageParams 的值域：朴素对象、至多 MAX_IMAGE_PARAMS_KEYS 个自有键，每个值
/// 只能是字符串（≤MAX_IMAGE_PARAM_VALUE）/ 有限数字 / 布尔——不允许嵌套对象或
/// 数组（嵌套结构没有深度/大小上限，等于给巨 blob 开了后门）。
function validateImageParams(v) {
  if (!isPlainObject(v)) return "imageParams must be a plain object";
  const keys = Object.keys(v);
  if (keys.length > MAX_IMAGE_PARAMS_KEYS) return `imageParams has too many keys (max ${MAX_IMAGE_PARAMS_KEYS})`;
  for (const k of keys) {
    const val = v[k];
    if (typeof val === "string") {
      if (val.length > MAX_IMAGE_PARAM_VALUE) return `imageParams.${k} too long (max ${MAX_IMAGE_PARAM_VALUE})`;
    } else if (typeof val === "number") {
      if (!Number.isFinite(val)) return `imageParams.${k} must be a finite number`;
    } else if (typeof val === "boolean") {
      // ok
    } else {
      return `imageParams.${k} must be a string, finite number, or boolean`;
    }
  }
  return null;
}

/// node 里第一个不在 allowed 白名单里的键名，没有则 null。node 此时保证是 JSON.parse 产出的
/// 朴素对象（调用点已经过滤过 null/数组/原始值），Object.keys 不会抛。
function firstUnknownKey(node, allowed) {
  for (const k of Object.keys(node)) {
    if (!allowed.has(k)) return k;
  }
  return null;
}

/// 返回错误信息字符串（→ 400 body）或 null（通过）。整个函数是 total：接收任意
/// JSON.parse 产出的值（对象/数组/字符串/数字/布尔/null 的任意嵌套），只返回
/// string|null，绝不 throw——校验器炸了会把本该的 400 变成 500。
export function validateList(template, items) {
  try {
    return validateListUnsafe(template, items);
  } catch (e) {
    // belt-and-suspenders：万一上面漏了什么 hostile 形状，也绝不能把 400 变成 500。
    return `validation error: ${(e && e.message) || String(e)}`;
  }
}

function validateListUnsafe(template, items) {
  if (!Array.isArray(items)) return "items must be an array";

  const idx = templateIndex(template);
  const seen = new Set();
  let count = 0;

  // depth 0 = 顶层，1 = 组内。两级封顶 = depth 1 不许再出现 group。
  const walk = (node, depth) => {
    count++;
    if (count > MAX_ITEMS) return `too many items (max ${MAX_ITEMS})`;
    if (!node || typeof node !== "object" || Array.isArray(node)) return "bad node";

    if (node.ref) {
      if (!idx.has(node.ref)) return `unknown ref: ${node.ref}`;
      if (seen.has(node.ref)) return `duplicate id: ${node.ref}`;
      seen.add(node.ref);
      const t = idx.get(node.ref);
      const isGroup = t.type === "group";
      const badKey = firstUnknownKey(node, isGroup ? REF_GROUP_KEYS : REF_ACTION_KEYS);
      if (badKey) return `unexpected field on ref node: ${badKey}`;
      if (isGroup) {
        if (depth > 0) return "groups may only appear at the top level (two levels max)";
        if (node.children !== undefined && !Array.isArray(node.children)) return "children must be an array";
        for (const c of node.children || []) {
          const err = walk(c, 1);
          if (err) return err;
        }
      }
      return null;
    }

    // 实体
    if (!USER_ID_RE.test(node.id || "")) return `bad id: ${node.id} (want ^p_[a-z0-9]{6,}$)`;
    if (seen.has(node.id)) return `duplicate id: ${node.id}`;
    seen.add(node.id);

    if (node.type !== "action" && node.type !== "group") return `bad type: ${node.type}`;

    const isGroup = node.type === "group";
    const badKey = firstUnknownKey(node, isGroup ? ENTITY_GROUP_KEYS : ENTITY_ACTION_KEYS);
    if (badKey) return `${isGroup ? "group" : "action"} must not carry field: ${badKey}`;

    const rawLabel = typeof node.label === "string" ? node.label : "";
    if (!rawLabel.trim()) return "label must not be empty";
    if (rawLabel.length > MAX_LABEL) return `label too long (max ${MAX_LABEL})`;
    if (node.forkedFrom !== undefined && !idx.has(node.forkedFrom)) return `unknown forkedFrom: ${node.forkedFrom}`;

    if (isGroup) {
      if (depth > 0) return "groups may only appear at the top level (two levels max)";
      if (node.children !== undefined && !Array.isArray(node.children)) return "children must be an array";
      for (const c of node.children || []) {
        const err = walk(c, 1);
        if (err) return err;
      }
      return null;
    }

    // action
    if (typeof node.prompt !== "string" || !node.prompt.trim()) return "prompt must not be empty";
    if (node.prompt.length > MAX_PROMPT) return `prompt too long (max ${MAX_PROMPT})`;
    if (!Array.isArray(node.appliesTo) || node.appliesTo.length === 0) return "appliesTo must be a non-empty array";
    for (const a of node.appliesTo) if (!APPLIES.has(a)) return `bad appliesTo value: ${a}`;
    if (node.kind !== undefined) {
      if (typeof node.kind !== "string" || node.kind.length > MAX_KIND) return `bad kind (want string, max ${MAX_KIND})`;
    }
    if (node.importedFrom !== undefined) {
      if (typeof node.importedFrom !== "string" || !IMPORT_CODE_RE.test(node.importedFrom)) {
        return "bad importedFrom (want 7-digit share code)";
      }
    }
    if (node.imageParams !== undefined) {
      const err = validateImageParams(node.imageParams);
      if (err) return err;
    }
    return null;
  };

  for (const node of items) {
    const err = walk(node, 0);
    if (err) return err;
  }
  return null;
}

// ── 恢复默认（一个按钮两个用途：删多了的后悔药 + 拿系统新出的 prompt）──────────
//
// 【为什么不做"模板新增项自动追加"】自动追加会把用户【主动删掉】的条目塞回来，
// 要修就得引入 deleted:[] 墓碑列表——多一个字段，换一个用户不可控的行为。
// 一个显式按钮既是后悔药，又是新 prompt 的入口。见 spec §4。

/// 整棵树（顶层 + 所有 children）一次性收集"已覆盖"的模板 id 集合：
/// 被 ref，或被某个实体 forkedFrom。树宽扫描——不管这个 ref/fork 现在躺在
/// 哪一层、哪个组底下（哪怕是被用户从原来的组里拖出来的），都算数。
/// 这比按"当前所在的那个 scope"分别判断更简单，也更对：一个模板 id
/// 只要在树的任意位置已经被认领，就不该在别处被判定为"缺"而重复补。
function collectCoverage(nodes) {
  const covered = new Set();
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const n of list) {
      if (isJunkNode(n)) continue;                  // 垃圾节点：跳过，绝不访问 .ref/.children
      if (n.ref) covered.add(n.ref);
      if (n.forkedFrom) covered.add(n.forkedFrom);
      if (n.children) visit(n.children);
    }
  };
  visit(nodes);
  return covered;
}

/// 节点计数，口径与 validateList 的 walk 完全一致：每个节点（含每一层
/// children 里的每个节点）都算 1。用来在追加时始终知道"现在数到几了"。
function countNodes(nodes) {
  let n = 0;
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (isJunkNode(node)) continue;                // 垃圾节点：不计数，不访问 .children
      n++;
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return n;
}

/// 顶层节点的浅拷贝：group 节点自己的 children 数组也另起一份（同时把 children
/// 里混进的垃圾元素过滤掉），这样后面往里 push 缺的子项不会连带修改调用方传入的
/// items。垃圾顶层节点本身 → null（调用方 .filter(Boolean) 丢掉，不进入输出）。
/// children 存在但不是数组（对象/数字/字符串/布尔）→ 当"没有 children"处理，
/// 整个 key 丢掉——不能把这坨形状不对的东西留在输出里，后面 g.children 相关逻辑
/// 全部假定 children 要么不存在要么是数组。
function cloneTop(node) {
  if (isJunkNode(node)) return null;
  if (!Array.isArray(node.children)) {
    if (node.children === undefined) return { ...node };
    const { children, ...rest } = node;
    return rest;
  }
  return { ...node, children: node.children.filter((c) => !isJunkNode(c)) };
}

/// 返回【新的用户列表】（原始存储形状：ref / 实体，不是解析结果）：
/// 模板里缺的顶层项按模板顺序补回末尾；组内缺的 action 补回该组末尾。
/// 不修改 items（含嵌套 children 数组），也不修改 template（模块级字面量，
/// 活过整个 Worker isolate——改了它会污染后面每一个请求读到的模板）。
///
/// 两条不变式，输出是要被直接持久化的，必须守住：
///   1. 封顶感知——一路数着节点数（组和它的 children 都算），数到
///      MAX_ITEMS 就停手，绝不吐出一份连自己的 validateList 都拒收的文档。
///   2. "已覆盖"是全树口径（见 collectCoverage）——一个 ref/fork 不管在
///      树里哪个位置，都能让对应的模板 id 被认作"已有"，不会因为它被
///      拖出了原来的组就被判定为"缺"而重复补。
/// 供 import / restore-defaults 端点复用：把【已经落盘的用户列表】清洗成可以安全
/// 追加 / 再处理的副本——过滤掉垃圾顶层节点、垃圾 children 节点（跟 resolveList/
/// restoreDefaults 对垃圾节点的容忍度一致），并且【悬空 ref】（模板热更后已经不
/// 在 template 里的 sys_*）也当垃圾节点同等对待，一并丢弃——不新增/不删除任何
/// 其余有效节点、不改变顺序。
///
/// 为什么需要这个：validateList 对垃圾节点、悬空 ref 都是【零容忍】的（直接判
/// "bad node" / "unknown ref"），但 resolveList（读路径）对二者都是静默跳过——
/// prompt-template.json 是 R2 里可热调的配置，一个 sys_* 从模板里退休，是完全合法
/// 的运营动作，不该让所有还持有那条 ref 的用户永远卡在 400/500。存量 prompts.json
/// 还可能混了老版本代码或存储层损坏写进去的垃圾节点。import / restore-defaults
/// 如果直接把 doc.items 原样拿来处理再喂给 validateList，会让"用户本来就有的
/// 垃圾节点 / 悬空 ref"把这一次全新的、跟它们毫无关系的写操作也一起拖成 400/500
/// ——必须先清洗，写路径与读路径对这两类历史脏数据的处理必须一致。
///
/// 同时顺手做一次浅层拷贝（顶层数组 + 每个 group 的 children 数组都是新的），
/// 调用方可以放心 push，不会污染 loadUserPrompts 返回的原始对象。
///
/// template 参数：可以传整棵模板（{schema,items}）或已经打平的 templateIndex
/// （Map<id,node>）——已经有 idx 在手的调用方不用再打平一遍。
export function sanitizeStoredItems(items, template) {
  const idx = template instanceof Map ? template : templateIndex(template);
  const sanitizeChild = (c) => {
    if (isJunkNode(c)) return null;               // cloneTop 已经过滤过一遍，这里是双重保险
    if (c.ref && !idx.has(c.ref)) return null;     // 悬空 ref child：模板热更已经不认这个 id 了
    return c;
  };
  const out = [];
  for (const raw of items || []) {
    const cloned = cloneTop(raw);
    if (!cloned) continue;                         // 垃圾顶层节点
    if (cloned.ref && !idx.has(cloned.ref)) continue; // 悬空顶层 ref：整条（含 children）一起丢
    if (Array.isArray(cloned.children)) cloned.children = cloned.children.filter(sanitizeChild);
    out.push(cloned);
  }
  return out;
}

/// 整树 PUT 的 importedFrom 保全：老客户端（PromptNode 没建模这个字段）整树 PUT
/// 会把导入标记静默剥掉，导入幂等就此失效——所以 PUT 落盘前按实体 id 从旧文档
/// 把标记补回来。只补「旧文档有、新文档没带」的（客户端显式删除条目 = id 消失，
/// 自然不补；将来若有客户端想主动清除标记，得先在这里开口子）。原地修改 newItems。
export function preserveImportMarkers(oldItems, newItems) {
  const marks = new Map();
  const collect = (list) => {
    for (const n of list || []) {
      if (isJunkNode(n)) continue;
      if (!n.ref && typeof n.id === "string" && typeof n.importedFrom === "string"
          && IMPORT_CODE_RE.test(n.importedFrom)) marks.set(n.id, n.importedFrom);
      if (Array.isArray(n.children)) collect(n.children);
    }
  };
  collect(oldItems);
  if (!marks.size) return;
  const apply = (list) => {
    for (const n of list || []) {
      if (isJunkNode(n)) continue;
      if (!n.ref && n.type === "action" && n.importedFrom === undefined && marks.has(n.id)) {
        n.importedFrom = marks.get(n.id);
      }
      if (Array.isArray(n.children)) apply(n.children);
    }
  };
  apply(newItems);
}

export function restoreDefaults(template, items) {
  const out = (items || []).map(cloneTop).filter(Boolean);   // 垃圾顶层节点：丢弃，不进入输出
  const covered = collectCoverage(out);
  let count = countNodes(out);

  // 尝试往 arr 里追加一个节点；数满了就拒绝（并让调用方知道该收手了）。
  const push = (arr, node) => {
    if (count >= MAX_ITEMS) return false;
    arr.push(node);
    count++;
    return true;
  };

  fill: for (const t of template.items || []) {
    const isGroup = t.type === "group";

    if (covered.has(t.id)) {
      // 顶层已经有了（ref 命中，或某个实体 forkedFrom 命中，不管在树的哪个位置）。
      if (!isGroup) continue;
      const g = out.find((n) => n.ref === t.id || n.forkedFrom === t.id);
      // g 理论上一定存在（covered 刚判定为真，且命中的一定是顶层节点——
      // covered 里的 id 若是靠某个 group 的 forkedFrom 命中，那个 group
      // 节点本身必然在顶层）；防一手脏数据——万一是个 type 对不上的实体
      // （forkedFrom 指向 group 但自己是 action），不要把 children 塞进
      // 一个不该有 children 的节点。
      if (!g || (g.type && g.type !== "group")) continue;
      // 显式补上 children：ref 组没有 children 这个 key 会被 resolveList 解析成空组，
      // 这里既然要处理这个组（哪怕什么都不缺），就把它的 children 明确写出来。
      g.children = g.children ? [...g.children] : [];
      for (const c of t.children || []) {
        if (covered.has(c.id)) continue;
        if (!push(g.children, { ref: c.id })) break fill;
      }
      continue;
    }

    // 顶层缺失。组的话，只把"树宽范围内也仍然缺"的子项展开——如果某个
    // 子项已经被用户拖出组、以 fork 的形式活在树的别处，它就不该在这里
    // 被重新塞回一份 {ref:...}（否则 resolveList 后同一个模板项出现两次）。
    if (isGroup) {
      const missingChildren = (t.children || []).filter((c) => !covered.has(c.id));
      if (missingChildren.length === 0) continue; // 每个子项都已在别处被覆盖，组本身不必补
      const newGroup = { ref: t.id, children: [] };
      if (!push(out, newGroup)) break fill;
      for (const c of missingChildren) {
        if (!push(newGroup.children, { ref: c.id })) break fill;
      }
    } else {
      if (!push(out, { ref: t.id })) break fill;
    }
  }

  return out;
}
