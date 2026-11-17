import assert from "node:assert/strict";
import {test} from "node:test";
import {createAmazonBedrock} from "@ai-sdk/amazon-bedrock";
import {createAnthropic} from "@ai-sdk/anthropic";
import {createGoogleGenerativeAI} from "@ai-sdk/google";
import {createOpenAI} from "@ai-sdk/openai";
import {execute} from "@restatedev/restate-sdk-gen";
import type {LanguageModel} from "ai";
import {agent} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";

// The real provider packages parse the error; only HTTP is faked.
type Fetch = typeof globalThis.fetch;
const providers = {
  openai: (fetch) => createOpenAI({apiKey: "test-only", fetch}).chat("gpt-test"),
  anthropic: (fetch) => createAnthropic({apiKey: "test-only", fetch})("claude-sonnet-4-5"),
  bedrock: (fetch) =>
    createAmazonBedrock({
      region: "us-east-1",
      accessKeyId: "test-only",
      secretAccessKey: "test-only",
      fetch,
    })("anthropic.claude-sonnet-4-5"),
  google: (fetch) => createGoogleGenerativeAI({apiKey: "test-only", fetch})("gemini-2.5-flash"),
} satisfies Record<string, (fetch: Fetch) => LanguageModel>;
const restateDefault = 50;

/** How long Restate waits before retrying a model call that got this 429. */
async function retryDelay(
  provider: (fetch: Fetch) => LanguageModel,
  response: {body?: unknown; headers?: Record<string, string>},
  streaming = false,
) {
  let requests = 0;
  const fetch: Fetch = async () => {
    requests++;
    return Response.json(response.body ?? errorBody, {status: 429, headers: response.headers});
  };
  const onChunk = streaming ? async () => {} : undefined;
  const a = agent({model: aiModel({model: provider(fetch), onChunk})});
  const failure = await runHandler((ctx) => execute(ctx, a.run("hello"))).then(
    () => assert.fail("expected a retryable failure"),
    (error: Error & {nextRetryDelay?: number}) => error,
  );
  assert.match(failure.message, /SDK failure.*slow down/);
  assert.equal(requests, 1);
  return failure.nextRetryDelay;
}

// One body every provider's error schema accepts: Anthropic's `type` fields
// alongside Google's `code` and `status`, and Bedrock's top-level `message`.
const errorBody = {
  type: "error",
  message: "slow down",
  error: {type: "rate_limit_error", code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED"},
};

void test("every provider passes its retry-after header on to Restate", async () => {
  for (const streaming of [false, true])
    for (const [name, provider] of Object.entries(providers)) {
      const delay = await retryDelay(provider, {headers: {"retry-after": "7"}}, streaming);
      assert.equal(delay, 7000, `${name}${streaming ? " (stream)" : ""}`);
    }
});

void test("retry-after headers are read", async () => {
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toUTCString();
  const cases: {headers: Record<string, string>; delay: [number, number]}[] = [
    {headers: {"retry-after-ms": "1500.5"}, delay: [1501, 1501]},
    {headers: {"retry-after": "7"}, delay: [7000, 7000]},
    // Longer than the AI SDK would wait in process; Restate waits durably.
    {headers: {"retry-after": "120"}, delay: [120_000, 120_000]},
    // HTTP dates have whole seconds, so the wait is up to a second shorter.
    {headers: {"retry-after": inSeconds(30)}, delay: [28_000, 30_000]},
    {headers: {"retry-after-ms": "2000", "retry-after": "9"}, delay: [2000, 2000]},
    // An unusable value falls through to the next header.
    {headers: {"retry-after-ms": "soon", "retry-after": "3"}, delay: [3000, 3000]},
    {headers: {"retry-after-ms": "-1", "retry-after": "5"}, delay: [5000, 5000]},
    {headers: {"retry-after-ms": "Infinity", "retry-after": "5"}, delay: [5000, 5000]},
    // Unusable or missing headers keep Restate's own backoff.
    {headers: {"retry-after": inSeconds(-30)}, delay: [restateDefault, restateDefault]},
    {headers: {"retry-after": "later"}, delay: [restateDefault, restateDefault]},
    {headers: {}, delay: [restateDefault, restateDefault]},
  ];
  for (const {headers, delay} of cases) {
    const actual = (await retryDelay(providers.openai, {headers})) ?? -1;
    const [min, max] = delay;
    assert.ok(min <= actual && actual <= max, `${JSON.stringify(headers)}: waited ${actual} ms`);
  }
});

void test("Google's RetryInfo sets the wait when no header does", async () => {
  const google = (details: unknown[], headers?: Record<string, string>) =>
    retryDelay(providers.google, {body: {error: {...errorBody.error, details}}, headers});
  const info = (retryDelay: unknown) => ({
    "@type": "type.googleapis.com/google.rpc.RetryInfo",
    retryDelay,
  });
  const quota = {"@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: []};
  assert.equal(await google([quota, info("30s")]), 30_000);
  assert.equal(await google([info("1.5s")]), 1500);
  // A header wins over the body.
  assert.equal(await google([info("30s")], {"retry-after": "2"}), 2000);
  // An unusable header falls through to the body.
  assert.equal(await google([info("30s")], {"retry-after": "-2"}), 30_000);
  // A missing or unreadable RetryInfo keeps Restate's own backoff.
  assert.equal(await google([quota]), restateDefault);
  assert.equal(await google([info("soon")]), restateDefault);
  assert.equal(await google([info(30)]), restateDefault);
});

void test("only Google models read RetryInfo from the body", async () => {
  const body = {
    ...errorBody,
    error: {
      ...errorBody.error,
      details: [{"@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s"}],
    },
  };
  for (const name of ["openai", "anthropic", "bedrock"] as const)
    assert.equal(await retryDelay(providers[name], {body}), restateDefault, name);
});
