import type { Job } from "./store.js";

export function buildArgs(job: Job, outPath: string): string[] {
  const { prompt, mode, params } = job;
  // `--provider` is a GLOBAL option and must precede the subcommand (verified against
  // gpt-image-2-skill v0.7.1 `--help`): the `images generate|edit` / `transparent generate`
  // subcommands reject `--provider` if it appears after them.
  const globals = ["--json", "--json-events", "--provider", "codex"];
  const common = ["--prompt", prompt, "--out", outPath];
  const sizeQuality = ["--size", params.size, "--quality", params.quality];

  if (params.transparent) {
    if (mode === "edit") {
      throw new Error("transparent output is not supported for edit (transparent+edit)");
    }
    return [...globals, "transparent", "generate", ...common, ...sizeQuality];
  }

  const fmt = ["--format", params.format];
  const comp = params.compression != null ? ["--compression", String(params.compression)] : [];

  if (mode === "edit") {
    if (!job.inputPath) throw new Error("edit mode requires inputPath");
    return [...globals, "images", "edit", ...common, "--ref-image", job.inputPath, ...fmt, ...sizeQuality, ...comp];
  }
  return [...globals, "images", "generate", ...common, ...fmt, ...sizeQuality, ...comp];
}

export function parseResult(stdout: string): { ok: boolean; error?: { code: string; message: string } } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { ok: false, error: { code: "parse_error", message: "no JSON on stdout" } };
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1));
    if (obj?.ok === true) return { ok: true };
    return { ok: false, error: obj?.error ?? { code: "unknown", message: "engine reported failure" } };
  } catch {
    return { ok: false, error: { code: "parse_error", message: "stdout not valid JSON" } };
  }
}

export function parseEventLine(line: string): { percent?: number; phase?: string } | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const ev = JSON.parse(t);
    if (ev?.kind === "sse") return null;
    const out: { percent?: number; phase?: string } = {};
    if (typeof ev?.data?.percent === "number") out.percent = ev.data.percent;
    if (typeof ev?.data?.phase === "string") out.phase = ev.data.phase;
    else if (typeof ev?.type === "string") out.phase = ev.type;
    if (out.percent === undefined && out.phase === undefined) return null;
    return out;
  } catch {
    return null;
  }
}
