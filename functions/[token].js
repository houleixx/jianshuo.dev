// voicedrop.cn 根路径短链：https://voicedrop.cn/<id> 直接打开公开文章页。
// jianshuo.dev 没备案，微信里打开分享链接会弹「非微信官方网页」提示；分享域名
// 迁到 voicedrop.cn（同一个 Pages 项目的 custom domain）。此函数只在 voicedrop.cn
// 的 host 上劫持单段路径，其它域名（jianshuo.dev 的静态页 /a/ /viz 等）一律
// context.next() 放行；老链接 jianshuo.dev/voicedrop/<id> 由原函数继续服务。
import { onRequest as sharePage } from "./voicedrop/[token].js";

export async function onRequest(context) {
  const host = new URL(context.request.url).hostname;
  if (host !== "voicedrop.cn" && host !== "www.voicedrop.cn") return context.next();
  // 复用 /voicedrop/<id> 的整套渲染（id 校验 / shares 与社区双解析 / og 标签）。
  return sharePage(context);
}
