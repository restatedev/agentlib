import assert from "node:assert/strict";
import {test} from "node:test";
import {createAnthropic} from "@ai-sdk/anthropic";
import {createGoogleGenerativeAI} from "@ai-sdk/google";
import {createOpenAI} from "@ai-sdk/openai";
import * as r from "@restatedev/restate-sdk-gen";
import {MockLanguageModelV4, simulateReadableStream} from "ai/test";
import {z} from "zod";
import {
  agent,
  journaledModel,
  LazyStateConversation,
  summarizeConversation,
  tool,
  type Message,
  type Model,
  type ModelRequest,
  type Reasoning,
} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {estimateTokens} from "../../core/src/context-size.js";
import {runHandler} from "./replay-harness.mjs";
import {memoryStore, testContext} from "./helpers.js";

const context = () => testContext("reasoning");
const lookup = tool({
  description: "Look up a record",
  input: z.object({}),
  *execute() {
    return "found";
  },
});
const signed = (text: string, signature: string): Reasoning => ({
  items: [{type: "reasoning", text, providerOptions: {anthropic: {signature}}}],
  tokens: 40,
});
const assistants = (messages: readonly Message[]) =>
  messages.filter((m): m is Extract<Message, {role: "assistant"}> => m.role === "assistant");

// --- What a run keeps -------------------------------------------------------------------

void test("a step's reasoning is kept with it and goes back on the next request", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    tools: {lookup},
    *model(request) {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            type: "tool_calls",
            calls: [{id: "one", name: "lookup", input: {}}],
            reasoning: signed("Look it up.", "s1"),
          }
        : {type: "final", text: "Found", reasoning: signed("Done.", "s2")};
    },
  });
  const result = await r.execute(context(), a.run("Find it"));
  assert.equal(result.status, "completed");
  // The second request carries the first step's reasoning, unchanged.
  assert.deepEqual(assistants(requests[1]!.messages)[0]?.reasoning, signed("Look it up.", "s1"));
  // The tool step and the final answer both keep theirs.
  assert.deepEqual(
    assistants(result.messages).map((m) => m.reasoning),
    [signed("Look it up.", "s1"), signed("Done.", "s2")],
  );
});

void test("an answer drops its reasoning when an output policy changes the output", async () => {
  const result = await r.execute(
    context(),
    agent({
      *model() {
        return {type: "final", text: "Private", reasoning: signed("Because.", "s")};
      },
      *afterRun(result) {
        if (result.status === "completed") return {output: "Public"};
      },
    }).run("Go"),
  );
  assert.deepEqual(result.messages.at(-1), {
    role: "assistant",
    content: "Public",
  });
});

void test("a policy returning an unchanged structured answer keeps reasoning", async () => {
  const reasoning = signed("Because.", "s");
  const result = await r.execute(
    context(),
    agent({
      output: z.object({answer: z.string()}),
      *model() {
        return {type: "final", text: '{"answer":"ok"}', output: {answer: "ok"}, reasoning};
      },
      *afterRun() {
        return {output: {answer: "ok"}};
      },
    }).run("Go"),
  );
  assert.deepEqual(assistants(result.messages)[0]?.reasoning, reasoning);
});

void test("a policy redacting structured output drops reasoning", async () => {
  const result = await r.execute(
    context(),
    agent({
      output: z.object({answer: z.string()}),
      *model() {
        return {
          type: "final",
          text: '{"answer":"secret"}',
          output: {answer: "secret"},
          reasoning: signed("Secret detail", "sig"),
        };
      },
      *afterRun() {
        return {output: {answer: "public"}};
      },
    }).run("Go"),
  );
  assert.deepEqual(result.messages.at(-1), {role: "assistant", content: '{"answer":"public"}'});
});

void test("a rejected structured answer keeps reasoning for correction, not in committed history", async () => {
  const requests: ModelRequest[] = [];
  const reasoning = signed("First attempt", "sig");
  const result = await r.execute(
    context(),
    agent({
      output: z.object({answer: z.number()}),
      *model(request) {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? {type: "final", text: '{"answer":"wrong"}', reasoning}
          : {type: "final", text: '{"answer":42}'};
      },
    }).run("Go"),
  );
  assert.deepEqual(assistants(requests[1]!.messages)[0]?.reasoning, reasoning);
  assert.doesNotMatch(JSON.stringify(result.messages), /First attempt|wrong/);
});

const answering = (requests: ModelRequest[]) => {
  let calls = 0;
  const model: Model = journaledModel(async (request) => {
    requests.push(structuredClone(request));
    calls++;
    return {
      type: "final",
      text: `Answer ${calls}`,
      reasoning: signed(`Thought ${calls}`, `s${calls}`),
    };
  });
  return {model, calls: () => calls};
};

void test("reasoning is saved with the conversation and comes back next turn", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    *model(request) {
      requests.push(structuredClone(request));
      const n = requests.length;
      return {type: "final", text: `Answer ${n}`, reasoning: signed(`Thought ${n}`, `s${n}`)};
    },
  });
  const conversation = new LazyStateConversation({store: memoryStore().store});
  await r.execute(
    context(),
    (function* () {
      yield* a.run("First", {conversation});
      yield* a.run("Second", {conversation});
    })(),
  );
  assert.deepEqual(assistants(requests[1]!.messages)[0]?.reasoning, signed("Thought 1", "s1"));
});

void test("a run with reasoning replays to the same history without asking the model", async () => {
  const requests: ModelRequest[] = [];
  const {model, calls} = answering(requests);
  const a = agent({model});
  const handler = (ctx: Parameters<typeof r.execute>[0]) => r.execute(ctx, a.run("First"));
  const live = await runHandler(handler);
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(calls(), 1);
  assert.deepEqual(assistants(live.output.messages)[0]?.reasoning, signed("Thought 1", "s1"));
});

// --- Size and summaries -----------------------------------------------------------------

void test("reasoning counts at its reported tokens, not by its encrypted characters", () => {
  const answer = (reasoning?: Reasoning): Message => ({
    role: "assistant",
    content: "Done",
    ...(reasoning ? {reasoning} : {}),
  });
  const encrypted: Reasoning = {
    items: [{type: "reasoning", text: "", providerOptions: {openai: {enc: "x".repeat(4000)}}}],
    tokens: 14,
  };
  assert.equal(estimateTokens([answer(encrypted)]), estimateTokens([answer()]) + 14);
});

void test("summaries read reasoning as text, never its signatures or encrypted content", async () => {
  let seen = "";
  await r.execute(
    context(),
    summarizeConversation(
      function* (request) {
        seen = JSON.stringify(request.messages);
        return {type: "final", text: "Summary"};
      },
      {
        messages: [
          {role: "user", content: "Hi"},
          {role: "assistant", content: "Hello", reasoning: signed("Greet them back.", "SECRET")},
        ],
        through: 2,
        baseThrough: 0,
      },
    ),
  );
  assert.match(seen, /Greet them back/);
  assert.doesNotMatch(seen, /SECRET/);
});

void test("a conversation's maxChars ignores encrypted reasoning", async () => {
  const convo = new LazyStateConversation({store: memoryStore().store});
  await r.execute(
    context(),
    (function* () {
      const encrypted: Reasoning = {
        items: [{type: "reasoning", text: "", providerOptions: {openai: {enc: "x".repeat(5000)}}}],
        tokens: 14,
      };
      yield* convo.append(
        [
          {role: "user", content: "Hi"},
          {role: "assistant", content: "Hello", reasoning: encrypted},
        ],
        0,
      );
      assert.equal(
        yield* convo.prepareCompaction({maxMessages: 64, maxChars: 1000, retainMessages: 1}),
        undefined,
      );
    })(),
  );
});

// --- Through the AI SDK, per provider -----------------------------------------------------

const openaiResponse = (output: unknown[], usage: Record<string, unknown> = {}) =>
  Response.json({
    id: "resp",
    model: "gpt-5.6-luna",
    output,
    usage: {input_tokens: 10, output_tokens: 20, ...usage},
  });
const openaiMessage = (text: string) => ({
  type: "message",
  id: "msg",
  role: "assistant",
  content: [{type: "output_text", text, annotations: []}],
});

for (const store of [undefined, true])
  void test(`OpenAI Chat keeps the store setting and reasoning effort (store: ${store ?? "default"})`, async () => {
    const requests: Record<string, any>[] = [];
    const openai = createOpenAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        return Response.json({
          choices: [
            {index: 0, finish_reason: "stop", message: {role: "assistant", content: "Done"}},
          ],
        });
      },
    });
    const model = aiModel({
      model: openai.chat("gpt-5"),
      providerOptions: {openai: {reasoningEffort: "high", ...(store === undefined ? {} : {store})}},
    });
    const result = await runHandler((ctx) => r.execute(ctx, agent({model}).run("Think")));
    assert.equal(result.output.output, "Done");
    assert.equal(requests[0]!.store, store ?? false);
    assert.equal(requests[0]!.reasoning_effort, "high");
  });

for (const store of [undefined, true])
  void test(`OpenAI reasoning goes back on the next step (store: ${store ?? "default"})`, async () => {
    const requests: Record<string, any>[] = [];
    const openai = createOpenAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        if (requests.length === 1)
          return openaiResponse(
            [
              {type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: []},
              {type: "function_call", id: "fc_1", call_id: "one", name: "lookup", arguments: "{}"},
            ],
            {output_tokens_details: {reasoning_tokens: 14}},
          );
        return openaiResponse([openaiMessage("Found")]);
      },
    });
    const model = aiModel({
      model: openai("gpt-5.6-luna"),
      ...(store === undefined ? {} : {providerOptions: {openai: {store}}}),
    });
    const live = await runHandler((ctx) =>
      r.execute(ctx, agent({model, tools: {lookup}}).run("Find")),
    );
    assert.equal(live.output.output, "Found");
    // OpenAI keeps nothing unless the caller asks; then the reasoning goes back by reference.
    assert.equal(requests[0]!.store, store ?? false);
    const sent = requests[1]!.input.find(
      (item: {type?: string}) => item.type === "reasoning" || item.type === "item_reference",
    );
    assert.deepEqual(
      sent,
      store
        ? {type: "item_reference", id: "rs_1"}
        : {type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: []},
    );
    // Recorded at the tokens OpenAI reported for the reasoning.
    assert.equal(assistants(live.output.messages)[0]?.reasoning?.tokens, 14);
  });

const anthropicResponse = (content: unknown[], stop: string) =>
  Response.json({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {input_tokens: 10, output_tokens: 30},
  });
const anthropicStub = (requests: Record<string, any>[]) =>
  createAnthropic({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      if (requests.length === 1)
        return anthropicResponse(
          [
            {type: "thinking", thinking: "Look it up.", signature: "sig-1"},
            {type: "tool_use", id: "toolu_1", name: "lookup", input: {}},
          ],
          "tool_use",
        );
      return anthropicResponse([{type: "text", text: "Found"}], "end_turn");
    },
  });

void test("Claude's signed thinking goes back before the tool call it led to", async () => {
  const requests: Record<string, any>[] = [];
  const model = aiModel({model: anthropicStub(requests)("claude-sonnet-5-5"), caching: false});
  const live = await runHandler((ctx) =>
    r.execute(ctx, agent({model, tools: {lookup}}).run("Find")),
  );
  assert.equal(live.output.output, "Found");
  const assistant = requests[1]!.messages.find((m: {role: string}) => m.role === "assistant");
  assert.deepEqual(assistant.content, [
    {type: "thinking", thinking: "Look it up.", signature: "sig-1"},
    {type: "tool_use", id: "toolu_1", name: "lookup", input: {}},
  ]);
  // Anthropic reports no separate reasoning count: the response's output stands in.
  assert.equal(assistants(live.output.messages)[0]?.reasoning?.tokens, 30);
});

void test("Gemini's thought signature goes back on its tool call", async () => {
  const requests: Record<string, any>[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      const parts =
        requests.length === 1
          ? [{functionCall: {name: "lookup", args: {}}, thoughtSignature: "sig-A"}]
          : [{text: "Found"}];
      return Response.json({
        candidates: [{content: {role: "model", parts}, finishReason: "STOP"}],
        usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15},
      });
    },
  });
  const model = aiModel({model: google("gemini-3-flash")});
  const live = await runHandler((ctx) =>
    r.execute(ctx, agent({model, tools: {lookup}}).run("Find")),
  );
  assert.equal(live.output.output, "Found");
  const turn = requests[1]!.contents.find((c: {role: string}) => c.role === "model");
  // The real signature, not Google's skip placeholder.
  assert.equal(turn.parts[0].thoughtSignature, "sig-A");
});

for (const parts of [
  [{text: "Found", thoughtSignature: "sig-A"}],
  [{text: "First "}, {text: "second", thoughtSignature: "sig-B"}],
  [
    {text: "First ", thoughtSignature: "sig-A"},
    {text: "second", thoughtSignature: "sig-B"},
  ],
])
  void test(`Gemini preserves signatures and boundaries on ${parts.length} text parts: ${parts[0]!.thoughtSignature ?? "unsigned first"}`, async () => {
    const requests: Record<string, any>[] = [];
    const google = createGoogleGenerativeAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        return Response.json({
          candidates: [
            {
              content: {role: "model", parts: requests.length === 1 ? parts : [{text: "Again"}]},
              finishReason: "STOP",
            },
          ],
          usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15},
        });
      },
    });
    const a = agent({model: aiModel({model: google("gemini-3-flash")})});
    const handler = (ctx: Parameters<typeof r.execute>[0]) =>
      r.execute(
        ctx,
        (function* () {
          const conversation = new LazyStateConversation({store: memoryStore().store});
          const first = yield* a.run("First", {conversation});
          yield* a.run("Next", {conversation});
          return first;
        })(),
      );
    const live = await runHandler(handler);
    assert.deepEqual(
      requests[1]!.contents.find((turn: {role: string}) => turn.role === "model").parts,
      parts,
    );
    const kept = assistants(live.output.messages)[0]!;
    assert.equal(kept.content, parts.map((part) => part.text).join(""));
    assert.deepEqual(
      kept.reasoning?.text,
      parts.map(({text, thoughtSignature}) => ({
        text,
        ...(thoughtSignature ? {providerOptions: {google: {thoughtSignature}}} : {}),
      })),
    );
    assert.equal(
      estimateTokens([kept]),
      estimateTokens([{role: "assistant", content: kept.content}]),
    );
    const replay = await runHandler(handler, {replay: live.journal});
    assert.deepEqual(replay.output, live.output);
    assert.equal(requests.length, 2);
  });

for (const redact of [false, true])
  void test(`Gemini structured output keeps original signed text unless redacted: ${redact}`, async () => {
    const requests: Record<string, any>[] = [];
    const original = {text: '{ "answer": 42 }', thoughtSignature: "answer-sig"};
    const google = createGoogleGenerativeAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        return Response.json({
          candidates: [{content: {role: "model", parts: [original]}, finishReason: "STOP"}],
        });
      },
    });
    const a = agent({
      model: aiModel({model: google("gemini-3-flash")}),
      output: z.object({answer: z.number()}),
      *afterRun() {
        if (redact) return {output: {answer: 0}};
      },
    });
    const handler = (ctx: Parameters<typeof r.execute>[0]) =>
      r.execute(
        ctx,
        (function* () {
          const conversation = new LazyStateConversation({store: memoryStore().store});
          const first = yield* a.run("First", {conversation});
          yield* a.run("Next", {conversation});
          return first;
        })(),
      );
    const live = await runHandler(handler);
    assert.deepEqual(live.output.output, {answer: redact ? 0 : 42});
    assert.equal(
      assistants(live.output.messages)[0]!.content,
      redact ? '{"answer":0}' : '{"answer":42}',
    );
    assert.deepEqual(
      requests[1]!.contents.find((turn: {role: string}) => turn.role === "model").parts,
      redact ? [{text: '{"answer":0}'}] : [original],
    );
    if (redact) assert.doesNotMatch(JSON.stringify(live.output.messages), /42|answer-sig/);
    const replay = await runHandler(handler, {replay: live.journal});
    assert.deepEqual(replay.output, live.output);
    assert.equal(requests.length, 2);
  });

void test("Gemini's streamed signature on an empty trailing text chunk survives the next turn", async () => {
  const requests: Record<string, any>[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      const parts =
        requests.length === 1
          ? [{text: "Found"}, {text: "", thoughtSignature: "stream-sig"}]
          : [{text: "Again"}];
      const chunks = parts.map((part) => ({
        candidates: [{content: {role: "model", parts: [part]}}],
      }));
      const finish = {
        candidates: [{content: {role: "model", parts: []}, finishReason: "STOP"}],
        usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15},
      };
      return new Response(
        [...chunks, finish].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
        {headers: {"content-type": "text/event-stream"}},
      );
    },
  });
  const a = agent({model: aiModel({model: google("gemini-3-flash"), onChunk: async () => {}})});
  const first = await runHandler((ctx) => r.execute(ctx, a.run("First")));
  await runHandler((ctx) => r.execute(ctx, a.run("Next", {messages: first.output.messages})));
  assert.deepEqual(
    requests[1]!.contents.find((turn: {role: string}) => turn.role === "model").parts,
    [{text: "Found", thoughtSignature: "stream-sig"}],
  );
});

void test("redacting a Gemini answer drops both readable reasoning and text signatures before the next turn", async () => {
  const requests: Record<string, any>[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts:
                requests.length === 1
                  ? [
                      {text: "Secret thought", thought: true, thoughtSignature: "thought-sig"},
                      {text: "Secret answer", thoughtSignature: "answer-sig"},
                    ]
                  : [{text: "Again"}],
            },
            finishReason: "STOP",
          },
        ],
      });
    },
  });
  const a = agent({
    model: aiModel({model: google("gemini-3-flash")}),
    *afterRun() {
      return {output: "Public answer"};
    },
  });
  const first = await runHandler((ctx) => r.execute(ctx, a.run("First")));
  assert.deepEqual(first.output.messages.at(-1), {role: "assistant", content: "Public answer"});
  await runHandler((ctx) => r.execute(ctx, a.run("Next", {messages: first.output.messages})));
  const next = JSON.stringify(requests[1]);
  assert.match(next, /Public answer/);
  assert.doesNotMatch(next, /Secret|thoughtSignature/);
});

void test("streamed reasoning is kept like generated reasoning", async () => {
  const prompts: unknown[] = [];
  const usage = {
    inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0},
    outputTokens: {total: 9, text: 1, reasoning: 8},
  };
  const provider = new MockLanguageModelV4({
    doStream: async ({prompt}) => {
      prompts.push(prompt);
      const first = prompts.length === 1;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {type: "stream-start", warnings: []},
            ...(first
              ? [
                  {type: "reasoning-start" as const, id: "r"},
                  {type: "reasoning-delta" as const, id: "r", delta: "Look it up."},
                  {
                    type: "reasoning-end" as const,
                    id: "r",
                    providerMetadata: {anthropic: {signature: "sig-1"}},
                  },
                  {type: "tool-call" as const, toolCallId: "one", toolName: "lookup", input: "{}"},
                ]
              : [
                  {type: "text-start" as const, id: "t"},
                  {type: "text-delta" as const, id: "t", delta: "Found"},
                  {type: "text-end" as const, id: "t"},
                ]),
            {
              type: "finish",
              finishReason: first
                ? {unified: "tool-calls" as const, raw: "tool_use"}
                : {unified: "stop" as const, raw: "end_turn"},
              usage,
            },
          ],
        }),
      };
    },
  });
  const model = aiModel({model: provider, caching: false, onChunk: async () => {}});
  const live = await runHandler((ctx) =>
    r.execute(ctx, agent({model, tools: {lookup}}).run("Find")),
  );
  assert.equal(live.output.output, "Found");
  const assistant = (prompts[1] as {role: string; content: unknown[]}[]).find(
    (m) => m.role === "assistant",
  );
  assert.deepEqual(assistant!.content[0], {
    type: "reasoning",
    text: "Look it up.",
    providerOptions: {anthropic: {signature: "sig-1"}},
  });
  assert.equal(assistants(live.output.messages)[0]?.reasoning?.tokens, 8);
});

void test("another model of the same provider gets the reasoning; another provider does not", async () => {
  const fromClaude: Record<string, any>[] = [];
  const claude = anthropicStub(fromClaude);
  const first = await runHandler((ctx) =>
    r.execute(
      ctx,
      agent({
        model: aiModel({model: claude("claude-sonnet-5-5"), caching: false}),
        tools: {lookup},
      }).run("Find"),
    ),
  );
  const history: Message[] = first.output.messages;

  // Another Claude model: the signed thinking goes along.
  const toOpus: Record<string, any>[] = [];
  const opus = createAnthropic({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      toOpus.push(JSON.parse(init!.body as string));
      return anthropicResponse([{type: "text", text: "Again"}], "end_turn");
    },
  });
  await runHandler((ctx) =>
    r.execute(
      ctx,
      agent({
        model: aiModel({model: opus("claude-opus-5-5"), caching: false}),
        tools: {lookup},
      }).run("Again", {messages: history}),
    ),
  );
  assert.match(JSON.stringify(toOpus[0]!.messages), /"signature":"sig-1"/);

  // OpenAI: the AI SDK leaves Claude's thinking out, and the request goes through.
  const toOpenAI: Record<string, any>[] = [];
  const openai = createOpenAI({
    apiKey: "test-only",
    fetch: async (_url, init) => {
      toOpenAI.push(JSON.parse(init!.body as string));
      return openaiResponse([openaiMessage("Again")]);
    },
  });
  const switched = await runHandler((ctx) =>
    r.execute(
      ctx,
      agent({model: aiModel({model: openai("gpt-5.6-luna")}), tools: {lookup}}).run("Again", {
        messages: history,
      }),
    ),
  );
  assert.equal(switched.output.output, "Again");
  const sent = JSON.stringify(toOpenAI[0]!.input);
  assert.doesNotMatch(sent, /sig-1|"type":"reasoning"/);
});
