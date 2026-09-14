// src/jsonl.ts — 流式逐行读 JSONL，支持从字节偏移续读（2026-09-12）。
//
// 大文件防线（2026-08-23）：一个 121MB 的 codex rollout 曾把「readFile 整读 + split」
// 打爆 node 堆。所以一律流式逐行，内存与文件大小无关；单行超上限丢弃。
//
// 增量（2026-09-12）：写书中的 rollout 每几秒都在长，侧栏每次刷新、回看页每 12s 轮询
// 都按 (mtime,size) 判缓存失效——失效就从头重扫百 MB，单核 VPS 持续 30%+ CPU 陪跑。
// rollout 是 append-only，所以缓存记住「读到哪个字节」，下次 createReadStream({start})
// 只读新增的那几行。
//
// 只吐**以 \n 结尾的完整行**：还没写完的尾巴留在文件里下次再读，offset 不越过它——
// 否则半行会被解析一次、写完后又被解析一次。要兼容「最后一行没有换行符」的老式文件，
// 传 yieldTail=true（一次性全读的调用方用；增量调用方绝不能用）。
import { createReadStream } from "node:fs";

export type LineCursor = { offset: number };

const NL = 0x0a;

export async function* jsonlLinesFrom(
  path: string,
  cursor: LineCursor,
  opts: { maxLineBytes?: number; yieldTail?: boolean } = {},
): AsyncGenerator<string> {
  const maxLineBytes = opts.maxLineBytes ?? 2 * 1024 * 1024;
  const stream = createReadStream(path, { start: cursor.offset, highWaterMark: 1 << 20 });
  let carry: Buffer = Buffer.alloc(0);
  let dropping = false; // 正在跳过一条超长行，直到它的 \n
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let i: number;
    while ((i = carry.indexOf(NL)) >= 0) {
      const lineBuf = carry.subarray(0, i);
      carry = carry.subarray(i + 1);
      cursor.offset += i + 1;
      if (dropping) { dropping = false; continue; }
      if (lineBuf.length > maxLineBytes) continue;
      const line = lineBuf.toString("utf8");
      if (line.trim()) yield line;
    }
    if (carry.length > maxLineBytes) {
      // 半行已经超长：整行注定丢弃，别让它在内存里继续长
      cursor.offset += carry.length;
      carry = Buffer.alloc(0);
      dropping = true;
    }
  }
  if (opts.yieldTail && !dropping && carry.length) {
    const line = carry.toString("utf8");
    cursor.offset += carry.length;
    if (line.trim() && carry.length <= maxLineBytes) yield line;
  }
}

/** 一次性从头读完（含无换行符的末行）。 */
export function jsonlLines(path: string, maxLineBytes?: number): AsyncGenerator<string> {
  return jsonlLinesFrom(path, { offset: 0 }, { maxLineBytes, yieldTail: true });
}
