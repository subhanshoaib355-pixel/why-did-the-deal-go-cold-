import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredSentimentModel,
  keywordSentiment,
  XaiSentimentModel,
} from "../agents/sentiment-agent.ts";
import type { FeedbackItem } from "../agents/types.ts";

const feedback: FeedbackItem[] = [
  { id: "E1", deal_id: "D001", date: "2026-10-01", source: "email", text: "Budget approval is delayed." },
];

test("automatically selects Grok when an xAI key is configured", () => {
  const model = configuredSentimentModel({ XAI_API_KEY: "configured-test-key" });
  assert.equal(model.name, "xai-grok-4.7");
});

test("uses keyword sentiment when no xAI key is configured", () => {
  assert.equal(configuredSentimentModel({}).name, "keyword");
  assert.equal(configuredSentimentModel({ SENTIMENT_PROVIDER: "keyword", XAI_API_KEY: "configured-test-key" }).name, "keyword");
});

test("requires a key when Grok is explicitly selected", () => {
  assert.throws(() => configuredSentimentModel({ SENTIMENT_PROVIDER: "xai" }), /XAI_API_KEY is required/);
});

test("sends feedback in one request and validates the Grok result", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const model = new XaiSentimentModel(
    "test-key",
    "grok-test",
    async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              results: [{ id: "E1", label: "negative", tone: "budget pressure", reason: "Budget approval is delayed." }],
            }),
          },
        }],
      }), { status: 200 });
    }
  );

  const result = await model.tag(feedback);

  assert.equal(requestedUrl, "https://api.x.ai/v1/chat/completions");
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.equal(result[0].deal_id, "D001");
  assert.equal(result[0].label, "negative");
  assert.equal(keywordSentiment.name, "keyword");
});

test("rejects malformed provider results instead of silently falling back", async () => {
  const model = new XaiSentimentModel(
    "test-key",
    "grok-test",
    async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [] }) } }],
    }), { status: 200 })
  );

  await assert.rejects(model.tag(feedback), /omitted one or more feedback records/);
});

test("includes the provider's safe error message for rejected requests", async () => {
  const model = new XaiSentimentModel(
    "test-key",
    "grok-test",
    async () => new Response(JSON.stringify({
      error: {
        message: "Unsupported response format",
        type: "invalid_request_error",
        code: "unsupported_value",
      },
    }), { status: 400 })
  );

  await assert.rejects(
    model.tag(feedback),
    /HTTP 400: invalid_request_error\/unsupported_value: Unsupported response format/
  );
});
