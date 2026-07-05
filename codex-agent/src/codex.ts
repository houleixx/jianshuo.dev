/**
 * codex exec 的参数构造 + `--json` JSONL 事件 → SSE 事件的翻译。
 * 真实事件 schema 以 VPS 实机录制的 fixture 为准（test/fixtures/real-events.jsonl）；
 * 翻译必须防御式：认识的翻译，不认识的忽略，任何一行都不许把服务弄崩。
 */
const MAX_OUTPUT_CHARS = 8000;

export function buildArgs(message: string, threadId: string | null, workspace: string): string[] {
  // danger-full-access：防线不在 CLI 沙箱，在 OS 层（非特权用户 + sudoers 白名单 + systemd 沙箱）。
  // --skip-git-repo-check：工作区不是 git repo，exec 模式不加这个会拒绝启动（实机验证）。
  const flags = ["--json", "-s", "danger-full-access", "-C", workspace, "--skip-git-repo-check"];
  if (threadId) return ["exec", "resume", threadId, message, ...flags];
  return ["exec", ...flags, message];
}

export function translate(line: string): { event: string; data: any }[] {
  const t = line.trim();
  if (!t) return [];
  let ev: any;
  try {
    ev = JSON.parse(t);
  } catch {
    return [];
  }
  const out: { event: string; data: any }[] = [];
  const type = String(ev?.type ?? "");
  const threadId = ev?.thread_id ?? ev?.session_id;
  if (threadId && (type === "thread.started" || type === "session.created")) {
    out.push({ event: "session", data: { threadId } });
  }
  const item = ev?.item;
  if (type === "item.completed" && item) {
    switch (item.type) {
      case "agent_message":
        if (item.text) out.push({ event: "text", data: { text: item.text } });
        break;
      case "reasoning":
        if (item.text) out.push({ event: "thinking", data: { text: item.text } });
        break;
      case "command_execution":
        out.push({
          event: "cmd",
          data: {
            command: item.command ?? "",
            exitCode: item.exit_code ?? null,
            output: clip(String(item.aggregated_output ?? item.output ?? "")),
          },
        });
        break;
      case "file_change":
        out.push({ event: "files", data: { changes: item.changes ?? [] } });
        break;
      case "error":
        out.push({ event: "error", data: { message: item.message ?? "unknown item error" } });
        break;
    }
  }
  if (type === "turn.completed") out.push({ event: "result", data: { usage: ev.usage ?? null } });
  if (type === "turn.failed" || type === "error") {
    out.push({ event: "error", data: { message: ev?.error?.message ?? ev?.message ?? "turn failed" } });
  }
  return out;
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…[truncated]" : s;
}
