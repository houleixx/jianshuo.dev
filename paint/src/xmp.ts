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
