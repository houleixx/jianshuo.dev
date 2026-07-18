import { readFile, writeFile, rename } from "node:fs/promises";

// src/xmp.ts — 出图文件内嵌 XMP 溯源（spec: docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md）
// 零依赖：XMP 包手拼；PNG/JPEG 的插块在本文件（Task 2 的 embedXmp）。

export interface XmpFields {
  /** undefined = 不写 dc:description（调用方 xmp_prompt:false） */
  prompt?: string;
  jobId: string;
  model: string;
  /** ISO 8601 */
  createDate: string;
  meta?: Record<string, string>;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

export function buildXmp(f: XmpFields): string {
  const attrs = [
    `xmp:CreatorTool="gpt-image-2 via paint.jianshuo.dev"`,
    `xmp:CreateDate="${esc(f.createDate)}"`,
    `paint:JobId="${esc(f.jobId)}"`,
    `paint:Model="${esc(f.model)}"`,
    ...Object.entries(f.meta ?? {}).map(([k, v]) => `paint:${cap(k)}="${esc(v)}"`),
  ];
  const desc = f.prompt === undefined
    ? ""
    : `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(f.prompt)}</rdf:li></rdf:Alt></dc:description>`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:paint="https://paint.jianshuo.dev/ns/1.0/" ${attrs.join(" ")}>${desc}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

export interface EmbedResult {
  embedded: boolean;
  reason?: string;
}

// PNG CRC32（不用 node:zlib 的 crc32——那是 v22.2+ 才有，查表 10 行更稳）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IHDR 块之后插 iTXt（keyword XML:com.adobe.xmp），XMP 的 PNG 标准位置 */
function pngInsert(data: Buffer, xmp: string): Buffer {
  const ihdrLen = data.readUInt32BE(8);
  const insertAt = 8 + 12 + ihdrLen; // 签名 + IHDR(len+type+data+crc)
  // iTXt payload: keyword\0 compressionFlag(0) compressionMethod(0) langTag\0 translatedKeyword\0 text
  const payload = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")]);
  const chunk = Buffer.concat([
    Buffer.alloc(4), Buffer.from("iTXt", "latin1"), payload, Buffer.alloc(4),
  ]);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return Buffer.concat([data.subarray(0, insertAt), chunk, data.subarray(insertAt)]);
}

/** SOI 之后插 APP1 XMP 段；段长上限 0xFFFF，超了返回原因字符串 */
function jpegInsert(data: Buffer, xmp: string): Buffer | string {
  const payload = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "utf8")]);
  if (payload.length + 2 > 0xffff) return "xmp too large for jpeg APP1";
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), payload]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([data.subarray(0, 2), seg, data.subarray(2)]);
}

/** 按内容签名嗅探（webp/未知格式跳过），临时文件 + rename 原子写回 */
export async function embedXmp(path: string, xmp: string): Promise<EmbedResult> {
  const data = await readFile(path);
  let out: Buffer | null = null;
  let reason = "unsupported format";
  if (data.length > 33 && data.subarray(0, 8).equals(PNG_SIG)) {
    out = pngInsert(data, xmp);
  } else if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) {
    const r = jpegInsert(data, xmp);
    if (typeof r === "string") reason = r;
    else out = r;
  }
  if (!out) return { embedded: false, reason };
  const tmp = `${path}.xmp-tmp`;
  await writeFile(tmp, out);
  await rename(tmp, path);
  return { embedded: true };
}
