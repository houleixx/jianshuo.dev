// 图片真实格式嗅探（magic bytes）。上传的照片一律叫 .jpg，但字节未必是 JPEG——
// 安卓/相册导入会把 PNG/WebP/HEIC 顶着 .jpg 名传上来。media_type 与字节不符时
// Anthropic 把整个请求 400（"specified using the image/jpeg media type, but the
// image appears to be …"），一张坏图拖垮整次挖矿/重写（2026-08-07 线上 restyle
// 连环 500 的根因）。认不出的格式（HEIC 等模型不收的）返回 null，调用方跳过该图
// ——正文里的 [[photo:key]] 标记照留，模型只是看不见画面。

// Anthropic 支持 jpeg/png/gif/webp 四种。bytes: ArrayBuffer | Uint8Array。
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// 同款嗅探，但入参是 base64 字符串（只解前 24 个字符 = 18 字节，够认全部四种）。
export function sniffB64ImageType(b64) {
  try {
    const head = atob(String(b64).slice(0, 24));
    const bytes = new Uint8Array(head.length);
    for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
    return sniffImageType(bytes);
  } catch (_) {
    return null;
  }
}
