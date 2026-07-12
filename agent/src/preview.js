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

// 行级语音编辑的打字机流：解析 edit_current_article 工具参数的 JSON 流
// {"ops":[{"op":"replace_line","line":3,"text":"…"},…]}，把 replace/insert 的
// text（和 set_title 的 title）增量剥出，带上 op 与行号。delete_lines 无文本。
// 事件：{i, op, line, text}。同 PreviewExtractor：任意切断安全、永不 throw。
export class EditOpsExtractor {
  constructor() { this.reset(); }

  reset() {
    this.started = false; this.done = false;
    this.depth = 0; this.inString = false; this.esc = false; this.uBuf = null;
    this.strBuf = "";
    this.opsDepth = null;        // "ops" 数组元素所在深度
    this.oIdx = -1;              // 当前 op 下标
    this.curOp = null;           // 当前元素的 op 值
    this.curLine = null;         // 当前元素的 line 值
    this.numBuf = null;          // line 数字累积
    this.pendingKey = null; this.curKey = null; this.expectValue = false;
    this.capturing = null;       // "text" | "title" | null
    this.heldText = "";          // op 未知时先攒着（模型基本按 op→line→text 出）
    this._out = []; this._cur = null;
  }

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

  _allowed() {
    if (this.capturing === "title") return this.curOp === "set_title";
    return this.curOp === "replace_line" || this.curOp === "insert_after";
  }
  _needsLine() { return this.capturing === "text"; }

  _emit(ch) {
    if (this.curOp === null || (this._needsLine() && this.curLine === null)) { this.heldText += ch; return; }
    if (!this._allowed()) return;
    if (this._cur && this._cur.i !== this.oIdx) { this._out.push(this._cur); this._cur = null; }
    if (!this._cur) this._cur = { i: this.oIdx, op: this.curOp, line: this._needsLine() ? this.curLine : null, text: "" };
    this._cur.text += ch;
  }
  _flushHeld() {
    if (!this.heldText) return;
    const held = this.heldText; this.heldText = "";
    if (this.capturing || this._allowed()) { for (const ch of held) this._emit(ch); }
  }

  _endNum() {
    if (this.numBuf === null) return;
    const n = parseInt(this.numBuf, 10);
    if (this.curKey === "line" && Number.isFinite(n)) { this.curLine = n; this._flushHeld(); }
    this.numBuf = null;
  }

  _char(ch) {
    if (!this.started) { if (ch === "{") { this.started = true; this.depth = 1; } return; }
    if (this.inString) return this._inString(ch);
    if (this.numBuf !== null) {
      if (/[0-9]/.test(ch)) { this.numBuf += ch; return; }
      this._endNum();  // 数字结束，继续按结构字符处理 ch
    }
    switch (ch) {
      case '"':
        this.inString = true; this.strBuf = "";
        if (this.expectValue) {
          this.expectValue = false;
          if ((this.curKey === "text" || this.curKey === "title")
              && this.oIdx >= 0 && this.opsDepth !== null && this.depth === this.opsDepth + 1) {
            this.capturing = this.curKey;
          } else if (this.curKey === "op" && this.oIdx >= 0 && this.depth === (this.opsDepth ?? -99) + 1) {
            this.capturing = "__op";
          }
        }
        break;
      case ":":
        this.curKey = this.pendingKey; this.pendingKey = null; this.expectValue = true;
        if (this.curKey === "line" && this.oIdx >= 0) this.numBuf = null;   // 等数字
        break;
      case "[":
        if (this.expectValue && this.curKey === "ops" && this.opsDepth === null) this.opsDepth = this.depth + 1;
        this.depth++; this.expectValue = false;
        break;
      case "{":
        if (this.opsDepth !== null && this.depth === this.opsDepth) {
          this.oIdx++; this.curOp = null; this.curLine = null; this.heldText = "";
        }
        this.depth++; this.expectValue = false;
        break;
      case "]": case "}":
        this.depth--;
        if (this.depth <= 0) this.done = true;
        break;
      case ",": this.expectValue = false; break;
      default:
        if (this.expectValue && this.curKey === "line" && /[0-9-]/.test(ch)) this.numBuf = (this.numBuf ?? "") + ch;
        break;
    }
  }

  _inString(ch) {
    if (this.uBuf !== null) {
      this.uBuf += ch;
      if (this.uBuf.length === 4) {
        const cp = parseInt(this.uBuf, 16);
        this._strCh(Number.isNaN(cp) ? "�" : String.fromCharCode(cp));
        this.uBuf = null;
      }
      return;
    }
    if (this.esc) {
      this.esc = false;
      if (ch === "u") { this.uBuf = ""; return; }
      const m = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      this._strCh(m[ch] ?? ch);
      return;
    }
    if (ch === "\\") { this.esc = true; return; }
    if (ch === '"') {
      this.inString = false;
      if (this.capturing === "__op") { this.curOp = this.strBuf; this._flushHeld(); }
      else if (!this.capturing) this.pendingKey = this.strBuf;
      this.capturing = null;
      this.strBuf = "";
      return;
    }
    this._strCh(ch);
  }

  _strCh(ch) {
    if (this.capturing === "text" || this.capturing === "title") this._emit(ch);
    else if (this.strBuf.length < 64) this.strBuf += ch;
  }
}

// 编辑 DO 里的实时预览分发器：挂在 callAnthropic 的 onEvent 上，识别工具块——
// write_article（整篇重写）→ 幽灵稿协议（preview-delta，同换风格）；
// edit_current_article（行级修改）→ 打字机协议（edit-preview）。
// DO 内直接 broadcast，无 HTTP 跳；全程 best-effort。
export function makeEditPreview(broadcast, { flushMs = 150, flushChars = 240 } = {}) {
  let extractor = null, kind = null, sawGhost = false;
  let pend = [], pendChars = 0, timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pend.length) return;
    try { broadcast({ type: kind === "ghost" ? "preview-delta" : "edit-preview", items: pend }); } catch (_) {}
    pend = []; pendChars = 0;
  };
  return {
    onEvent(ev) {
      try {
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          flush();
          if (ev.content_block.name === "write_article") {
            extractor = new PreviewExtractor(); kind = "ghost"; sawGhost = true;
            try { broadcast({ type: "preview-reset" }); } catch (_) {}
          } else if (ev.content_block.name === "edit_current_article") {
            extractor = new EditOpsExtractor(); kind = "ops";
          } else { extractor = null; kind = null; }
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && extractor) {
          for (const e of extractor.feed(ev.delta.partial_json || "")) { pend.push(e); pendChars += (e.text || "").length; }
          if (pendChars >= flushChars) flush();
          else if (pend.length && !timer) timer = setTimeout(flush, flushMs);
        } else if (ev.type === "content_block_stop" && extractor) {
          flush(); extractor = null; kind = null;
        }
      } catch (_) {}
    },
    // 整个编辑回合结束（工具已执行、updated 马上广播）：幽灵稿宣告完成。
    finish() {
      flush();
      if (sawGhost) { try { broadcast({ type: "preview-done", ok: true }); } catch (_) {} }
    },
  };
}
