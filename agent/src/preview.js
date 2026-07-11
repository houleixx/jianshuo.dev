// src/preview.js — 实时预览的增量提取器。
//
// 挖矿/重写的模型原始输出是一份 JSON（{"articles":[{"title":…,"body":…},…]}），
// 流式到达时不能直接推给 App（用户会看到 JSON 语法和转义符）。这个提取器逐字符
// 扫描不断增长的 JSON 流，只把 articles[i].title / articles[i].body 的字符串内容
// （转义还原后的纯文本）剥出来，供 WS 分批推给 App 做「幽灵稿」预览。
//
// 特性：任意字节边界切断安全（转义序列、\uXXXX、代理对跨 chunk 均可）；
// markdown 代码围栏等前导废话忽略（只认第一个 { 开始）；questions 等其他字段
// 不外漏；reset() 后可处理全新一份流（force 重试）。永不 throw——预览是
// best-effort，解析乱了就闭嘴，正式结果仍走终局落库那条路。
export class PreviewExtractor {
  constructor() { this.reset(); }

  reset() {
    this.started = false;        // 已见到第一个 {
    this.done = false;           // 顶层对象已闭合
    this.depth = 0;              // 结构嵌套深度（不含字符串内部）
    this.inString = false;
    this.esc = false;            // 前一字符是反斜杠
    this.uBuf = null;            // \uXXXX 的十六进制收集中（跨 chunk 安全）
    this.strBuf = "";            // 非捕获字符串（键名等）的累积
    this.capturing = false;      // 当前字符串是 title/body 的值
    this.captureField = null;    // "title" | "body"
    this.pendingKey = null;      // 刚闭合、还没遇到 : 的字符串
    this.curKey = null;          // 最近一个键名
    this.expectValue = false;    // 刚过 : ，下一个 token 是值
    this.articlesDepth = null;   // "articles" 数组元素所在的深度
    this.aIdx = -1;              // 当前文章下标
    this._cur = null;            // 本次 feed 内累积中的事件 {a, field, text}
    this._out = [];
  }

  /** 喂一段新到的原始文本，返回增量事件 [{a, field, text}]。 */
  feed(chunk) {
    try {
      for (const ch of String(chunk)) {
        if (this.done) break;
        this._char(ch);
      }
    } catch (_) { this.done = true; }
    const out = this._out;
    if (this._cur && this._cur.text) { out.push(this._cur); this._cur = null; }
    this._out = [];
    return out;
  }

  _char(ch) {
    if (!this.started) {
      if (ch === "{") { this.started = true; this.depth = 1; }
      return;
    }
    if (this.inString) return this._inString(ch);

    switch (ch) {
      case '"':
        this.inString = true;
        this.strBuf = "";
        if (this.expectValue) {
          this.expectValue = false;
          // 只捕获 articles 数组元素对象自己的 title/body（depth 正好是元素层+1）
          if ((this.curKey === "title" || this.curKey === "body")
              && this.aIdx >= 0 && this.articlesDepth !== null && this.depth === this.articlesDepth + 1) {
            this.capturing = true;
            this.captureField = this.curKey;
          }
        }
        break;
      case ":":
        this.curKey = this.pendingKey;
        this.pendingKey = null;
        this.expectValue = true;
        break;
      case "[":
        if (this.expectValue && this.curKey === "articles" && this.articlesDepth === null) {
          this.articlesDepth = this.depth + 1;
        }
        this.depth++;
        this.expectValue = false;
        break;
      case "{":
        if (this.articlesDepth !== null && this.depth === this.articlesDepth) this.aIdx++;
        this.depth++;
        this.expectValue = false;
        break;
      case "]":
      case "}":
        this.depth--;
        if (this.depth <= 0) this.done = true;
        break;
      case ",":
        this.expectValue = false;
        break;
      default:
        break; // 空白、数字、true/false/null——与提取无关
    }
  }

  _inString(ch) {
    if (this.uBuf !== null) {
      this.uBuf += ch;
      if (this.uBuf.length === 4) {
        const cp = parseInt(this.uBuf, 16);
        this._strChar(Number.isNaN(cp) ? "�" : String.fromCharCode(cp));
        this.uBuf = null;
      }
      return;
    }
    if (this.esc) {
      this.esc = false;
      if (ch === "u") { this.uBuf = ""; return; }
      const m = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      this._strChar(m[ch] ?? ch);
      return;
    }
    if (ch === "\\") { this.esc = true; return; }
    if (ch === '"') {
      this.inString = false;
      if (this.capturing) { this.capturing = false; this.captureField = null; }
      else this.pendingKey = this.strBuf;
      this.strBuf = "";
      return;
    }
    this._strChar(ch);
  }

  _strChar(ch) {
    if (this.capturing) {
      if (this._cur && (this._cur.a !== this.aIdx || this._cur.field !== this.captureField)) {
        this._out.push(this._cur);
        this._cur = null;
      }
      if (!this._cur) this._cur = { a: this.aIdx, field: this.captureField, text: "" };
      this._cur.text += ch;
    } else if (this.strBuf.length < 64) {
      this.strBuf += ch;   // 键名都很短；超长的必是没在捕获的值串，别白吃内存
    }
  }
}

// 把提取器接到「POST 给编辑 DO」上：合批（时间或字符数触发）、串行保序、
// best-effort（DO 不可达/无人连接时静默丢弃，绝不影响重写主流程）。
export function makePreviewPusher(post, { flushMs = 250, flushChars = 400 } = {}) {
  const ex = new PreviewExtractor();
  let pend = [];
  let pendChars = 0;
  let timer = null;
  let chain = Promise.resolve();
  const send = (obj) => { chain = chain.then(() => post(obj)).catch(() => {}); };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pend.length) return;
    send({ type: "preview-delta", items: pend });
    pend = []; pendChars = 0;
  };
  return {
    preview: {
      // force 重试前调用：App 清掉幽灵稿，提取器从头解析新一份流。
      reset() {
        ex.reset(); pend = []; pendChars = 0;
        if (timer) { clearTimeout(timer); timer = null; }
        send({ type: "preview-reset" });
      },
      text(t) {
        for (const e of ex.feed(t)) { pend.push(e); pendChars += e.text.length; }
        if (pendChars >= flushChars) flush();
        else if (pend.length && !timer) timer = setTimeout(flush, flushMs);
      },
    },
    async done(ok) {
      flush();
      send({ type: "preview-done", ok: !!ok });
      await chain;
    },
  };
}
