import { createHmac } from "node:crypto";

export interface CallbackPayload {
  job_id: string;
  status: "done" | "failed";
  result_url: string | null;
  format: string | null;
  size: string | null;
  bytes: number | null;
  error: { code: string; message: string } | null;
  callback_meta: unknown;
}

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliver(
  url: string,
  token: string | undefined,
  payload: CallbackPayload,
  secret: string,
  opts: { retries?: number; delayMs?: (attempt: number) => number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; attempts: number }> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? ((n) => 1000 * 2 ** (n - 1));
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paint-Job": payload.job_id,
    "X-Paint-Signature": sign(body, secret),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let attempts = 0;
  for (let n = 1; n <= retries; n++) {
    attempts = n;
    try {
      const res = await doFetch(url, { method: "POST", headers, body });
      if (res.ok) return { ok: true, attempts };
    } catch {
      /* network error → retry */
    }
    if (n < retries) await sleep(delayMs(n));
  }
  return { ok: false, attempts };
}
