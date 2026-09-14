// src/http-body.ts — 读 JSON 请求体，带大小上限（2026-09-12）。
//
// 以前四条 POST 路由各自 `body += c` 无上限累加，而 /api/book 与 /api/book/revise 在
// Caddy 里豁免了 basic_auth、鉴权发生在整包读完并 JSON.parse 之后——任何匿名客户端
// 灌一个几百 MB 的 body 就能把 node 堆打爆、连带整个服务重启。现在超限即停读（pause）
// 并拒绝，一个字节都不多攒；由路由答 413 + Connection: close，Node 在响应发完后
// 会因为请求体没读完而关掉这条连接。
import type { IncomingMessage } from "node:http";

export class BodyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<any> {
  return new Promise((resolve, reject) => {
    // Content-Length 明说超限的，连读都不读
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limitBytes) {
      req.pause();
      reject(new BodyError(413, `body too large (${declared} > ${limitBytes})`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        finish(() => {
          req.pause();
          req.removeAllListeners("data");
          reject(new BodyError(413, `body too large (> ${limitBytes})`));
        });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      finish(() => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          reject(new BodyError(400, "bad json"));
        }
      }),
    );
    req.on("error", (e) => finish(() => reject(new BodyError(400, String(e?.message ?? e)))));
  });
}
