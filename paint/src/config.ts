import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  dataDir: string;
  jobsDir: string;
  resultsDir: string;
  inputsDir: string;
  apiToken: string;
  callbackSigningSecret: string;
  maxConcurrency: number;
  retentionDays: number;
  gptImageBin: string;
  codexHome?: string;
  maxInputBytes: number;
  maxPromptChars: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.API_TOKEN;
  const callbackSigningSecret = env.CALLBACK_SIGNING_SECRET;
  if (!apiToken) throw new Error("Missing required env API_TOKEN");
  if (!callbackSigningSecret) throw new Error("Missing required env CALLBACK_SIGNING_SECRET");
  const dataDir = env.DATA_DIR ?? "/opt/paint/data";
  return {
    port: Number(env.PORT ?? 8788),
    host: env.HOST ?? "127.0.0.1",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "https://paint.jianshuo.dev").replace(/\/$/, ""),
    dataDir,
    jobsDir: join(dataDir, "jobs"),
    resultsDir: join(dataDir, "results"),
    inputsDir: join(dataDir, "inputs"),
    apiToken,
    callbackSigningSecret,
    maxConcurrency: Number(env.MAX_CONCURRENCY ?? 3),
    retentionDays: Number(env.RETENTION_DAYS ?? 30),
    gptImageBin: env.GPT_IMAGE_BIN ?? "gpt-image-2-skill",
    codexHome: env.CODEX_HOME,
    maxInputBytes: Number(env.MAX_INPUT_BYTES ?? 26214400),
    maxPromptChars: Number(env.MAX_PROMPT_CHARS ?? 4000),
  };
}
