// Number an article body's rows EXACTLY the way the iOS app does, so the 第N行 /
// 图M the user sees floating in the margin while holding to talk are the SAME
// numbers we hand the model — the model READS them off a 行号对照 table instead of
// counting lines itself (counting is where "模型理解的行 ≠ 我标的行" came from).
//
// This MUST stay byte-for-byte in step with the Swift side:
//   - segments  ← VoiceDropApp/Library.swift  ArticleBody.segments
//   - numbering ← VoiceDropApp/RecordingDetailView.swift  bodyRows()
//
// Algorithm:
//   1. Split the body at [[photo:<token>]] markers into text / photo segments,
//      trimming each text chunk of surrounding whitespace+newlines, dropping empties.
//      (When there are NO markers the whole body is one untrimmed text segment,
//       mirroring ArticleBody.segments' early return.)
//   2. Walk the segments with ONE continuous line counter:
//        - text segment: split on "\n", trim each line, drop empty → each is 第N行
//        - photo segment: → 第N行 AND 图M (M = running photo count)

/** Split a body into ordered text / photo segments (mirror of ArticleBody.segments). */
export function bodySegments(body) {
  const s = String(body ?? "");
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
 * Render the 行号对照 table the model reads to resolve 第N行 / 图M. One line per row:
 *   第3行：正文开头预览…
 *   第4行 = 图2：[[photo:photos/…/….jpg]]
 * Text previews are capped so a long article doesn't blow up the prompt; the full
 * body is already in the message for faithful rewriting.
 */
export function locatorTable(body, { previewChars = 60 } = {}) {
  const rows = numberBodyRows(body);
  return rows.map((r) => {
    if (r.kind === "photo") return `第${r.n}行 = 图${r.imgNo}：[[photo:${r.token}]]`;
    const t = r.text.length > previewChars ? r.text.slice(0, previewChars) + "…" : r.text;
    return `第${r.n}行：${t}`;
  }).join("\n");
}
