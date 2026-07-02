// Number an article body's rows EXACTLY the way the iOS app does, so the 第N行 /
// 图M the user sees floating in the margin while holding to talk are the SAME
// numbers we hand the model — the model READS them off the inline-numbered body
// instead of counting lines itself (counting is where "模型理解的行 ≠ 我标的行" came from).
//
// This MUST stay byte-for-byte in step with the Swift side:
//   - segments  ← VoiceDropApp/Library.swift  ArticleBody.segments
//   - numbering ← VoiceDropApp/RecordingDetailView.swift  bodyRows()
//
// Algorithm:
//   0. Strip ALL `<!--…-->` comments + trim (mirror of ArticleBody.stripOriginComment).
//      The app never renders comments, so they must not consume a 第N行 — this was the
//      off-by-one that mis-aimed 「改第3行」 on legacy `<!-- style: 风格 vN -->` bodies.
//      New bodies carry no comments (style is the `articles[i].style` FIELD since
//      2026-07-03); this strip is defense for stragglers, and an edit's rowsToBody
//      round-trip drops the dead comment for good (self-healing).
//   1. Split the body at [[photo:<token>]] markers into text / photo segments,
//      trimming each text chunk of surrounding whitespace+newlines, dropping empties.
//      (When there are NO markers the whole body is one comment-stripped text segment,
//       mirroring ArticleBody.segments' early return.)
//   2. Walk the segments with ONE continuous line counter:
//        - text segment: split on "\n", trim each line, drop empty → each is 第N行
//        - photo segment: → 第N行 AND 图M (M = running photo count)

/** Split a body into ordered text / photo segments (mirror of ArticleBody.segments). */
export function bodySegments(body) {
  const s = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const marker = /\[\[photo:([^\]]+)\]\]/g;
  const out = [];
  let cursor = 0, m, any = false;
  while ((m = marker.exec(s)) !== null) {
    any = true;
    if (m.index > cursor) {
      const t = s.slice(cursor, m.index).trim();
      if (t) out.push({ kind: "text", text: t });
    }
    out.push({ kind: "photo", token: m[1] });
    cursor = m.index + m[0].length;
  }
  if (!any) return [{ kind: "text", text: s }];   // no markers → whole body, one segment
  if (cursor < s.length) {
    const t = s.slice(cursor).trim();
    if (t) out.push({ kind: "text", text: t });
  }
  return out;
}

/**
 * Flatten a body into numbered rows. Every row — paragraph OR image — consumes one
 * slot of a single continuous 第N行 counter; an image additionally carries its 图M.
 * Returns [{ n, kind:'text'|'photo', text?, imgNo?, token? }].
 */
export function numberBodyRows(body) {
  const rows = [];
  let lineNo = 0, imgNo = 0;
  for (const seg of bodySegments(body)) {
    if (seg.kind === "text") {
      for (const raw of seg.text.split("\n")) {
        const para = raw.trim();
        if (!para) continue;
        lineNo += 1;
        rows.push({ n: lineNo, kind: "text", text: para });
      }
    } else {
      lineNo += 1; imgNo += 1;
      rows.push({ n: lineNo, kind: "photo", imgNo, token: seg.token });
    }
  }
  return rows;
}

/**
 * Render the article body with an inline 第N行 / 图M number on every row. This
 * single numbered copy is what we hand the model: it is BOTH the body (full text,
 * for faithful rewriting) AND the locator the user and model share — no separate
 * clean copy, no separate 行号对照 table. One row per line:
 *   第3行：整段正文（不截断）
 *   第4行 = 图2：[[photo:photos/…/….jpg]]
 * The numbers are an addressing overlay for the prompt ONLY — never stored, never
 * part of the saved body (applyArticleEdits resolves 第N行 back onto the clean
 * rows, and the model is told not to echo numbers into its output).
 */
export function inlineNumberedBody(body) {
  return numberBodyRows(body).map((r) =>
    r.kind === "photo"
      ? `第${r.n}行 = 图${r.imgNo}：[[photo:${r.token}]]`
      : `第${r.n}行：${r.text}`
  ).join("\n");
}

/** Re-serialize numbered rows back into a body string: one row per paragraph,
 *  blank-line separated; photo rows become their [[photo:<token>]] marker again.
 *  Normalizes paragraph spacing to "\n\n" — matches how miner/article bodies are
 *  already shaped, and what numberBodyRows would re-derive identically. */
export function rowsToBody(rows) {
  return rows.map((r) => (r.kind === "photo" ? `[[photo:${r.token}]]` : r.text)).join("\n\n");
}

/**
 * Apply locator-addressed edits to a body — the patch path that lets the model
 * delete / replace / insert a line (or delete an image) WITHOUT regenerating the
 * whole article. `ops` reference 第N行 exactly as the inline-numbered body the
 * model was shown (numbers come from numberBodyRows, the same the user sees). Returns
 * { body } on success, or { error, ... } so the agent loop can feed the failure
 * back to the model.
 *
 * Ops (set_title is handled by the caller — it's an article field, not a body line):
 *   { op:"delete_lines", lines:[n,...] }     delete those rows (images included — by 第N行)
 *   { op:"replace_line", line:n, text:"…" }  replace a TEXT row's whole paragraph
 *   { op:"insert_after", line:n, text:"…" }  insert a new paragraph after 第n行 (n=0 ⇒ prepend)
 * All line numbers refer to the ORIGINAL numbering, so a batch of ops in one call
 * stays consistent (we resolve every op against the pre-edit rows, then rebuild).
 */
export function applyArticleEdits(body, ops) {
  const rows = numberBodyRows(body);
  const byN = new Map(rows.map((r) => [r.n, r]));
  const deletions = new Set();
  const replacements = new Map(); // n -> new text
  const insertsAfter = new Map(); // n (0 = prepend) -> [text, ...]

  for (const op of ops || []) {
    if (!op || typeof op !== "object") return { error: "bad_op" };
    if (op.op === "delete_lines") {
      const lines = Array.isArray(op.lines) ? op.lines : [];
      if (!lines.length) return { error: "empty_lines" };
      for (const ln of lines) {
        if (!byN.has(ln)) return { error: "line_not_found", line: ln };
        deletions.add(ln);
      }
    } else if (op.op === "replace_line") {
      const r = byN.get(op.line);
      if (!r) return { error: "line_not_found", line: op.line };
      if (r.kind === "photo") return { error: "cannot_replace_photo", line: op.line };
      if (typeof op.text !== "string" || !op.text.trim()) return { error: "empty_text", line: op.line };
      replacements.set(op.line, op.text.trim());
    } else if (op.op === "insert_after") {
      const after = op.line === 0 ? 0 : op.line;
      if (after !== 0 && !byN.has(after)) return { error: "line_not_found", line: op.line };
      if (typeof op.text !== "string" || !op.text.trim()) return { error: "empty_text", line: op.line };
      if (!insertsAfter.has(after)) insertsAfter.set(after, []);
      insertsAfter.get(after).push(op.text.trim());
    } else {
      return { error: "unknown_op", op: op.op };
    }
  }

  const out = [];
  const emitInserts = (n) => {
    const ins = insertsAfter.get(n);
    if (ins) for (const t of ins) out.push({ kind: "text", text: t });
  };
  emitInserts(0); // prepend
  for (const r of rows) {
    if (deletions.has(r.n)) { /* dropped */ }
    else if (replacements.has(r.n)) out.push({ kind: "text", text: replacements.get(r.n) });
    else out.push(r);
    emitInserts(r.n);
  }
  return { body: rowsToBody(out) };
}
