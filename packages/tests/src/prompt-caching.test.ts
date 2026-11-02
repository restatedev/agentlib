import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {createAmazonBedrock} from "@ai-sdk/amazon-bedrock";
import {createAnthropic} from "@ai-sdk/anthropic";
import {agent, tool, type ModelUsage} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {z} from "zod";
import {runHandler} from "./replay-harness.mjs";

// The real provider packages render the request; only HTTP is faked.
const lookup = tool({
  description: "Look up an order",
  input: z.object({id: z.string()}),
  *execute({id}) {
    return {id, status: "shipped"};
  },
});
type Body = Record<string, any>;

/** Answers a tool call first, then a final text; records each request body. */
function server(reply: (step: number) => unknown) {
  const bodies: Body[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    assert.equal(typeof init?.body, "string");
    bodies.push(JSON.parse(init!.body as string));
    return Response.json(reply(bodies.length));
  };
  return {bodies, fetch: fetch as typeof globalThis.fetch};
}

async function run(model: ReturnType<typeof aiModel>) {
  const usages: ModelUsage[] = [];
  const a = agent({
    instructions: "Answer order questions.",
    tools: {lookup},
    model: function* (request) {
      const response = yield* model(request);
      if (response.usage) usages.push(response.usage);
      return response;
    },
  });
  const {output} = await runHandler((ctx) => r.execute(ctx, a.run("Where is order 7?")));
  assert.equal(output.status, "completed");
  return usages;
}

const anthropicReply = (step: number) => ({
  id: `msg_${step}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content:
    step === 1
      ? [{type: "tool_use", id: "t1", name: "lookup", input: {id: "7"}}]
      : [{type: "text", text: "Order 7 has shipped."}],
  stop_reason: step === 1 ? "tool_use" : "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: step === 1 ? 0 : 1200,
    cache_creation_input_tokens: step === 1 ? 1200 : 30,
  },
});
const anthropicModel = (fetch: typeof globalThis.fetch, caching?: boolean) =>
  aiModel({
    model: createAnthropic({apiKey: "test-only", fetch})("claude-sonnet-4-5"),
    ...(caching === undefined ? {} : {caching}),
  });
const cacheControls = (body: Body) =>
  body.messages.flatMap((message: Body, index: number) =>
    message.content.filter((part: Body) => part.cache_control).map(() => index),
  );

void test("Anthropic requests cache the instructions, the previous request and the newest message", async () => {
  const {bodies, fetch} = server(anthropicReply);
  const usages = await run(anthropicModel(fetch));
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body.system, [
      {type: "text", text: "Answer order questions.", cache_control: {type: "ephemeral"}},
    ]);
  }
  // The newest message moves the cache point forward; a second point marks
  // where the previous request ended, so a step that adds more blocks than
  // the provider looks back over still reads that request's cache.
  assert.deepEqual(cacheControls(bodies[0]!), [0]);
  assert.deepEqual(cacheControls(bodies[1]!), [0, 2]);
  assert.equal(bodies[1]!.messages.at(-1).content[0].type, "tool_result");
  // Cache reads and writes count in the input and are reported apart.
  assert.deepEqual(usages, [
    {inputTokens: 1210, outputTokens: 5, cacheWriteInputTokens: 1200},
    {inputTokens: 1240, outputTokens: 5, cachedInputTokens: 1200, cacheWriteInputTokens: 30},
  ]);
});

void test("caching: false sends no cache points", async () => {
  const {bodies, fetch} = server(anthropicReply);
  await run(anthropicModel(fetch, false));
  for (const body of bodies) {
    assert.deepEqual(body.system, [{type: "text", text: "Answer order questions."}]);
    assert.deepEqual(cacheControls(body), []);
  }
});

void test("Bedrock requests place cache points after the instructions, the previous request and the newest message", async () => {
  const {bodies, fetch} = server((step) => ({
    output: {
      message: {
        role: "assistant",
        content:
          step === 1
            ? [{toolUse: {toolUseId: "t1", name: "lookup", input: {id: "7"}}}]
            : [{text: "Order 7 has shipped."}],
      },
    },
    stopReason: step === 1 ? "tool_use" : "end_turn",
    usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 900},
  }));
  const model = createAmazonBedrock({
    region: "us-east-1",
    accessKeyId: "test-only",
    secretAccessKey: "test-only",
    fetch,
  })("anthropic.claude-sonnet-4-5");
  const usages = await run(aiModel({model}));
  for (const body of bodies) {
    assert.deepEqual(body.system, [
      {text: "Answer order questions."},
      {cachePoint: {type: "default"}},
    ]);
    const points = body.messages.flatMap((message: Body, index: number) =>
      message.content.filter((part: Body) => part.cachePoint).map(() => index),
    );
    assert.deepEqual(points, body === bodies[0] ? [0] : [0, 2]);
    assert.deepEqual(body.messages.at(-1).content.at(-1), {cachePoint: {type: "default"}});
  }
  assert.equal(usages[0]!.cachedInputTokens, 900);
});
