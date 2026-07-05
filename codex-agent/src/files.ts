/**
 * workspace 文件桥的纯逻辑：文件名净化 + 安全 join。
 * 这两个函数是上传/下载接口唯一碰路径的地方，把「不许逃出 workspace」这条
 * 不变量收敛在此，单独单测。
 */
import { basename, resolve, sep } from "node:path";

// 允许的文件名字符：中英文、数字、点、横线、下划线、空格。其余一律剔除。
const ALLOWED = /[^\w.\-一-龥 ]+/g;

/** 取 basename → 过滤危险字符 → 折叠空白。空名 / "." / ".." 抛错。 */
export function safeName(raw: string): string {
  const base = basename(String(raw ?? "").trim());
  const cleaned = base.replace(ALLOWED, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`unsafe or empty filename: ${JSON.stringify(raw)}`);
  }
  return cleaned;
}

/** 净化文件名后 join 进 workspace；结果必须仍在 workspace 内，否则抛错。 */
export function resolveInWorkspace(workspace: string, raw: string): string {
  const name = safeName(raw);
  const full = resolve(workspace, name);
  const root = resolve(workspace) + sep;
  if (!(full + sep).startsWith(root) && full + sep !== root) {
    throw new Error(`path escapes workspace: ${JSON.stringify(raw)}`);
  }
  return full;
}
