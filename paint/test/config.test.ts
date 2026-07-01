import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig reads values and derives dirs", () => {
  const cfg = loadConfig({
    API_TOKEN: "tok", CALLBACK_SIGNING_SECRET: "sec", DATA_DIR: "/tmp/paint-x",
  } as any);
  assert.equal(cfg.apiToken, "tok");
  assert.equal(cfg.callbackSigningSecret, "sec");
  assert.equal(cfg.jobsDir, "/tmp/paint-x/jobs");
  assert.equal(cfg.resultsDir, "/tmp/paint-x/results");
  assert.equal(cfg.inputsDir, "/tmp/paint-x/inputs");
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.maxConcurrency, 3);
});

test("loadConfig throws when secrets missing", () => {
  assert.throws(() => loadConfig({} as any), /API_TOKEN/);
});
