import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const persistDir = mkdtempSync(path.join(tmpdir(), "never-go-cold-xai-"));
const originalFetch = globalThis.fetch;
const originalEnv = {
  SAMPLE_MODE: process.env.SAMPLE_MODE,
  XAI_API_KEY: process.env.XAI_API_KEY,
  SENTIMENT_PROVIDER: process.env.SENTIMENT_PROVIDER,
  HMEM_PERSIST_DIR: process.env.HMEM_PERSIST_DIR,
};
let requestCount = 0;

process.env.SAMPLE_MODE = "true";
process.env.XAI_API_KEY = "test-only-key";
process.env.SENTIMENT_PROVIDER = "xai";
process.env.HMEM_PERSIST_DIR = persistDir;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://api.x.ai/v1/chat/completions");
  requestCount += 1;
  const body = JSON.parse(String(init?.body)) as {
    messages: { content: string }[];
  };
  const records = JSON.parse(body.messages[1].content) as { id: string }[];
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          results: records.map(({ id }) => ({
            id,
            label: "neutral",
            tone: "mock",
            reason: "Mock classification for integration test.",
          })),
        }),
      },
    }],
  }), { status: 200 });
};

const { whyDidDealGoCold } = await import("../agents/orchestrator.ts");

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(persistDir, { recursive: true, force: true });
});

test("orchestrator selects Grok and classifies feedback through the configured provider", async () => {
  const verdict = await whyDidDealGoCold("D001");

  assert.equal(verdict.sentimentModel, "xai-grok-4.7");
  assert.equal(verdict.sentimentWarning, null);
  assert.equal(requestCount, 1);
  assert.equal(verdict.sentiments.length, verdict.feedback.length);
  assert.ok(verdict.sentiments.every((item) => item.label === "neutral" && item.tone === "mock"));
});

test("auto provider recovers from Grok errors and reports local keyword fallback", async () => {
  process.env.SENTIMENT_PROVIDER = "auto";
  globalThis.fetch = async () => new Response("provider unavailable", { status: 503 });

  const verdict = await whyDidDealGoCold("D003");

  assert.equal(verdict.sentimentModel, "keyword-fallback");
  assert.match(verdict.sentimentWarning ?? "", /Grok failed \(xAI sentiment request failed with HTTP 503\)/);
  assert.equal(verdict.sentiments.length, verdict.feedback.length);
});

test("explicit xai provider still fails when Grok is unavailable", async () => {
  process.env.SENTIMENT_PROVIDER = "xai";
  globalThis.fetch = async () => new Response("provider unavailable", { status: 503 });

  await assert.rejects(whyDidDealGoCold("D004"), /xAI sentiment request failed with HTTP 503/);
});
