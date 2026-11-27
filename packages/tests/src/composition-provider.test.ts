import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context, TerminalError} from "@restatedev/restate-sdk";
import {APICallError, LoadAPIKeyError, UnsupportedFunctionalityError} from "ai";
import * as r from "@restatedev/restate-sdk-gen";
import {MockLanguageModelV4, simulateReadableStream} from "ai/test";
import {z} from "zod";
import {
  agent,
  AgentTerminalError,
  handoff,
  isAgentTerminal,
  Conversation,
  tool,
  usageOf,
  messagesOf,
  type ModelRequest,
  type ModelResponse,
} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";
import {memoryStore, testContext} from "./helpers.js";
const ctx = () => testContext("compose");
const usage = {
  inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0},
  outputTokens: {total: 1, text: 1, reasoning: 0},
};
const done: ModelResponse = {type: "final", text: "done"};

for (const streaming of [false, true]) {
  void test(`invalid tool input is repaired without repeating valid calls (${streaming ? "stream" : "generate"})`, async () => {
    let requests = 0;
    const writes: string[] = [];
    const calls = () =>
      (requests === 1
        ? [
            {id: "valid", input: '"valid"'},
            {id: "invalid", input: "{"},
          ]
        : [{id: "repaired", input: '"fixed"'}]
      ).map(({id, input}) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "write",
        input,
      }));
    const finishReason = () =>
      requests < 3
        ? {unified: "tool-calls" as const, raw: "tool_calls"}
        : {unified: "stop" as const, raw: "stop"};
    const provider = new MockLanguageModelV4({
      doGenerate: async () => {
        requests++;
        return {
          content: requests < 3 ? calls() : [{type: "text", text: "done"}],
          finishReason: finishReason(),
          usage,
          warnings: [],
        };
      },
      doStream: async () => {
        requests++;
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              {type: "stream-start", warnings: []},
              ...(requests < 3
                ? calls()
                : [
                    {type: "text-start" as const, id: "text"},
                    {type: "text-delta" as const, id: "text", delta: "done"},
                    {type: "text-end" as const, id: "text"},
                  ]),
              {type: "finish", finishReason: finishReason(), usage},
            ],
          }),
        };
      },
    });
    const a = agent({
      maxSteps: 3,
      model: aiModel({model: provider, ...(streaming ? {onChunk: async () => {}} : {})}),
      tools: {
        write: tool({
          description: "Write a string",
          // A raw malformed argument is also a string, so schema validation alone cannot protect this tool.
          input: z.string(),
          *execute(value) {
            return yield* r.run(async function write() {
              writes.push(value);
              return value;
            });
          },
        }),
      },
    });
    const handler = (context: Context) => r.execute(context, a.run("write"));
    const live = await runHandler(handler);
    assert.equal(live.output.output, "done");
    assert.deepEqual(writes, ["valid", "fixed"]);
    const failed = live.output.messages.find(
      (message: {role: string; callId?: string}) =>
        message.role === "tool" && message.callId === "invalid",
    );
    assert.equal(failed.result.status, "error");
    assert.equal(failed.result.code, "invalid_input");
    const nextPrompt = streaming
      ? provider.doStreamCalls[1]!.prompt
      : provider.doGenerateCalls[1]!.prompt;
    assert.match(JSON.stringify(nextPrompt), /invalid_input/);
    const replay = await runHandler(handler, {replay: live.journal});
    assert.deepEqual(replay.output, live.output);
    assert.deepEqual(writes, ["valid", "fixed"]);
    assert.equal(requests, 3);
  });
}

void test("a failed tool-free finalizer preserves an honest stopped result", async () => {
  const a = agent({
    maxSteps: 1,
    tools: {
      noop: tool({
        description: "fixture",
        input: z.object({}),
        *execute() {
          return null;
        },
      }),
    },
    *model() {
      return {type: "tool_calls", calls: [{id: "n", name: "noop", input: {}}]};
    },
    *finalize(request) {
      assert.deepEqual(request.tools, []);
      throw new Error("summary unavailable");
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.reason, "max_steps");
  assert.match(result.output!, /final summary could not be generated/);
});

void test("a response that announces tool calls without any gets another step", async () => {
  const prompts: unknown[] = [];
  const provider = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const announced = prompts.length === 1;
      return {
        content: [{type: "text", text: announced ? "apparently complete" : "the real answer"}],
        finishReason: announced
          ? {unified: "tool-calls", raw: "tool_calls"}
          : {unified: "stop", raw: "stop"},
        usage,
        warnings: [],
      };
    },
  });
  const a = agent({model: aiModel({model: provider})});
  const handler = (context: Context) => r.execute(context, a.run("go"));
  const first = await runHandler(handler);
  assert.equal(first.output.output, "the real answer");
  assert.match(JSON.stringify(prompts[1]), /invalid_response/);
  // Neither the rejected response nor the note is saved.
  assert.doesNotMatch(
    JSON.stringify(first.output.messages),
    /apparently complete|invalid_response/,
  );
  // The journal records the failed call, so a replay repeats it without the provider.
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(prompts.length, 2);
});

void test("handoff preserves completed history, changes tools/instructions, and keeps root guards/budgets", async () => {
  let guarded = 0;
  const specialist = agent({
    name: "specialist",
    instructions: "new instructions",
    *model(req) {
      assert.equal(req.instructions, "new instructions");
      assert.deepEqual(req.tools, []);
      assert.equal(req.messages.at(-1)?.role, "tool");
      return done;
    },
  });
  const triage = agent({
    name: "triage",
    tools: {transfer: handoff(specialist)},
    *model() {
      return {type: "tool_calls", calls: [{id: "h", name: "transfer", input: {}}]};
    },
    *afterRun() {
      guarded++;
    },
  });
  const result = await r.execute(ctx(), triage.run("go"));
  assert.equal(result.status, "completed");
  assert.equal(guarded, 1);
  const bounded = agent({
    maxSteps: 1,
    tools: {transfer: handoff(specialist)},
    *model() {
      return {type: "tool_calls", calls: [{id: "h", name: "transfer", input: {}}]};
    },
  });
  assert.equal((await r.execute(ctx(), bounded.run("go"))).status, "stopped");
});

void test("run-level tools remain available after a handoff", async () => {
  const lookup = tool({
    description: "run-level fixture",
    input: z.object({}),
    *execute() {
      return "found";
    },
  });
  const specialist = agent({
    name: "specialist",
    *model(req) {
      assert.deepEqual(
        req.tools.map((t) => t.name),
        ["lookup", "run_program", "read_tool_result"],
      );
      return done;
    },
  });
  const triage = agent({
    name: "triage",
    tools: {transfer: handoff(specialist)},
    *model() {
      return {type: "tool_calls", calls: [{id: "h", name: "transfer", input: {}}]};
    },
  });
  const result = await r.execute(ctx(), triage.run("go", {tools: {lookup}}));
  assert.equal(result.status, "completed");
});

void test("background work keeps its launching agent's tool context after a handoff", async () => {
  await r.execute(
    ctx(),
    (function* () {
      const release = r.channel<void>();
      let step = 0;
      const specialist = agent({
        name: "new",
        *model(req) {
          if (++step === 1) {
            yield* release.send();
            return {type: "final", text: "candidate"};
          }
          assert.match(JSON.stringify(req.messages), /original/);
          return done;
        },
      });
      const a = agent({
        tools: {
          transfer: handoff(specialist),
          wait: tool({
            description: "wait",
            input: z.object({}),
            background: true,
            *execute(_, c) {
              yield* release.receive;
              return yield* c.callTool("original", {});
            },
          }),
          original: tool({
            description: "old tool",
            input: z.object({}),
            *execute() {
              return "original";
            },
          }),
        },
        *model() {
          return {
            type: "tool_calls",
            calls: [
              {id: "w", name: "wait", input: {}},
              {id: "h", name: "transfer", input: {}},
            ],
          };
        },
      });
      assert.equal((yield* a.run("go")).status, "completed");
    })(),
  );
});

void test("structured output repairs invalid candidates and publishes only the guarded final value", async () => {
  let step = 0;
  const a = agent({
    output: z.object({answer: z.string()}),
    *model(req) {
      assert.ok(req.outputSchema);
      if (++step === 1) return {type: "final", text: '{"answer":3}'};
      return {type: "final", text: '{"answer":"yes"}'};
    },
    *afterRun(result) {
      if (result.status === "completed")
        return {output: {answer: result.output.answer.toUpperCase()}};
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.deepEqual(result.output, {answer: "YES"});
  assert.equal(step, 2);
});

void test("AI SDK provider adapter forwards instructions and schemas and replays without provider calls", async () => {
  let requests = 0;
  const provider = new MockLanguageModelV4({
    doGenerate: async (options) => {
      requests++;
      assert.equal(options.prompt[0]?.role, "system");
      assert.equal(options.responseFormat?.type, "json");
      return {
        content: [{type: "text", text: '{"answer":"yes"}'}],
        finishReason: {unified: "stop", raw: "stop"},
        usage,
        warnings: [],
      };
    },
  });
  const a = agent({
    instructions: "support instructions",
    model: aiModel({model: provider}),
    output: z.object({answer: z.string()}),
  });
  const handler = (context: Context) => r.execute(context, a.run("go"));
  const first = await runHandler(handler);
  assert.deepEqual(first.output.output, {answer: "yes"});
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(requests, 1);
});

// The note every failed run ends its history with, here for a cut-off reply.
const cutOffNote = {
  role: "user",
  content: JSON.stringify({
    source: "agent-runtime",
    type: "run-failed",
    message:
      "The model's reply was cut off at the output token limit. Raise maxOutputTokens if the reply needs more room; otherwise the model may be looping.",
  }),
};

for (const streaming of [false, true]) {
  void test(`a cut-off reply ends the run and keeps its reasoning, text and complete calls (${streaming ? "stream" : "generate"})`, async () => {
    let requests = 0;
    const writes: string[] = [];
    const finishReason = {unified: "length" as const, raw: "max_tokens"};
    // A complete call, a complete call the tool's schema would reject, and a call cut off part way.
    const calls = [
      {id: "complete", input: '"done"'},
      {id: "mistyped", input: "5"},
      {id: "partial", input: '"unfini'},
    ].map(({id, input}) => ({
      type: "tool-call" as const,
      toolCallId: id,
      toolName: "write",
      input,
    }));
    const provider = new MockLanguageModelV4({
      doGenerate: async () => {
        requests++;
        return {
          content: [
            {type: "reasoning", text: "Plan both writes."},
            {type: "text", text: "Writing both"},
            ...calls,
          ],
          finishReason,
          usage,
          warnings: [],
        };
      },
      doStream: async () => {
        requests++;
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              {type: "stream-start", warnings: []},
              {type: "reasoning-start", id: "r"},
              {type: "reasoning-delta", id: "r", delta: "Plan both writes."},
              {type: "reasoning-end", id: "r"},
              {type: "text-start", id: "t"},
              {type: "text-delta", id: "t", delta: "Writing both"},
              {type: "text-end", id: "t"},
              ...calls,
              {type: "finish", finishReason, usage},
            ],
          }),
        };
      },
    });
    const a = agent({
      model: aiModel({model: provider, ...(streaming ? {onChunk: async () => {}} : {})}),
      tools: {
        write: tool({
          description: "Write a string",
          input: z.string(),
          *execute(value) {
            writes.push(value);
            return value;
          },
        }),
      },
    });
    const handler = (context: Context) =>
      r.execute(
        context,
        (function* () {
          const conversation = new Conversation({store: memoryStore().store});
          try {
            yield* a.run("write", {conversation});
            return {failed: false};
          } catch (error) {
            if (!(error instanceof AgentTerminalError)) throw error;
            const saved = yield* conversation.load();
            return {
              message: error.message,
              usage: usageOf(error),
              history: messagesOf(error),
              messages: saved.messages,
            };
          }
        })(),
      );
    const live = await runHandler(handler);
    assert.match(live.output.message, /output token limit.*maxOutputTokens.*looping/);
    assert.equal(live.output.usage.outputTokens, 1);
    assert.deepEqual(writes, []);
    const result = {
      status: "error",
      code: "cut_off",
      message: "Not run: the reply was cut off at the output token limit",
    };
    // The run saves the reply, marked cut off, without the call it cut off part
    // way, and ends with the failed run's note. messagesOf returns the same history.
    assert.deepEqual(live.output.history, live.output.messages);
    const [input, reply, ...results] = live.output.messages;
    assert.deepEqual(input, {role: "user", content: "write"});
    assert.equal(reply.role, "assistant");
    assert.equal(reply.content, "Writing both");
    assert.equal(reply.cutOff, true);
    assert.equal(reply.reasoning.items[0].text, "Plan both writes.");
    assert.deepEqual(
      reply.calls.map((call: {id: string}) => call.id),
      ["complete", "mistyped"],
    );
    assert.deepEqual(results, [
      {role: "tool", callId: "complete", name: "write", result},
      {role: "tool", callId: "mistyped", name: "write", result},
      cutOffNote,
    ]);
    // The journaled reply ends a replay the same way, without asking the provider.
    const replay = await runHandler(handler, {replay: live.journal});
    assert.deepEqual(replay.output, live.output);
    assert.equal(requests, 1);
  });
}

void test("a later run continues from a cut-off reply's saved history", async () => {
  const conversation = new Conversation({store: memoryStore().store});
  const requests: ModelRequest[] = [];
  let step = 0;
  const a = agent({
    *model(request) {
      requests.push(structuredClone(request));
      if (++step === 1)
        return {
          type: "cut_off",
          text: "Partial",
          calls: [{id: "c1", name: "noop", input: {}}],
          reasoning: {items: [{type: "reasoning", text: "Thinking"}]},
        };
      return {type: "final", text: "done"};
    },
    tools: {
      noop: tool({
        description: "fixture",
        input: z.object({}),
        *execute() {
          throw new Error("a cut-off call never runs");
        },
      }),
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("first", {conversation})), (error: unknown) =>
    isAgentTerminal(error),
  );
  const result = await r.execute(ctx(), a.run("second", {conversation}));
  assert.equal(result.output, "done");
  // The next request is valid: the cut-off call is answered, and the failed run's
  // note comes before the new input.
  assert.deepEqual(
    requests[1]!.messages.map((message) => message.role),
    ["user", "assistant", "tool", "user", "user"],
  );
  assert.deepEqual(requests[1]!.messages[3], cutOffNote);
  assert.equal(
    requests[1]!.messages[1]!.role === "assistant" && requests[1]!.messages[1]!.cutOff,
    true,
  );
});

void test("a cut-off reply with nothing in it saves no assistant message", async () => {
  const conversation = new Conversation({store: memoryStore().store});
  const a = agent({
    *model() {
      return {type: "cut_off", text: ""};
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go", {conversation})), {
    name: "AgentTerminalError",
  });
  const saved = await r.execute(ctx(), conversation.load());
  assert.deepEqual(saved.messages, [{role: "user", content: "go"}, cutOffNote]);
});

void test("cut-off text longer than maxOutputChars is clipped as recorded", async () => {
  const conversation = new Conversation({store: memoryStore().store});
  const a = agent({
    maxOutputChars: 10,
    *model() {
      return {
        type: "cut_off",
        text: "x".repeat(50),
        reasoning: {
          items: [],
          text: [{text: "x".repeat(50), providerOptions: {google: {thoughtSignature: "s"}}}],
        },
      };
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go", {conversation})), {
    name: "AgentTerminalError",
  });
  const saved = await r.execute(ctx(), conversation.load());
  // The signed text no longer matches the clipped text, so it is left out.
  assert.deepEqual(saved.messages[1], {
    role: "assistant",
    content: "x".repeat(10),
    reasoning: {items: []},
    cutOff: true,
  });
});

// DeepInfra, streaming, reports tool_calls for a reply cut off inside a call, with
// the call's arguments closed early into valid JSON. A reply that used the whole
// limit is a cut-off before any other finish reason, also one that is a note otherwise.
const limitReasons = [
  {unified: "tool-calls", raw: "tool_calls"},
  {unified: "content-filter", raw: "content_filter"},
  {unified: "other", raw: "unknown"},
] as const;
for (const [streaming, finishReason] of [false, true].flatMap((s) =>
  limitReasons.map((reason) => [s, reason] as const),
)) {
  void test(`a reply that used the whole output limit counts as cut off whatever its finish reason (${finishReason.unified}, ${streaming ? "stream" : "generate"})`, async () => {
    const call = {
      type: "tool-call" as const,
      toolCallId: "w1",
      toolName: "write",
      input: JSON.stringify({path: "a.txt"}),
    };
    const full = {...usage, outputTokens: {total: 300, text: 300, reasoning: 0}};
    const provider = new MockLanguageModelV4({
      doGenerate: async () => ({content: [call], finishReason, usage: full, warnings: []}),
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {type: "stream-start", warnings: []},
            call,
            {type: "finish", finishReason, usage: full},
          ],
        }),
      }),
    });
    const writes: unknown[] = [];
    const a = agent({
      model: aiModel({model: provider, ...(streaming ? {onChunk: async () => {}} : {})}),
      maxOutputTokens: 300,
      tools: {
        write: tool({
          description: "Write a file",
          input: z.object({path: z.string(), content: z.string().optional()}),
          *execute(input) {
            writes.push(input);
            return "written";
          },
        }),
      },
    });
    const {output} = await runHandler((context: Context) =>
      r.execute(
        context,
        (function* () {
          try {
            yield* a.run("write it");
            return {failed: false};
          } catch (error) {
            if (!(error instanceof AgentTerminalError)) throw error;
            return {message: error.message, history: messagesOf(error)};
          }
        })(),
      ),
    );
    assert.match(output.message, /cut off at the output token limit/);
    assert.deepEqual(writes, []);
    // The call is recorded with a failed result instead of running.
    assert.deepEqual(output.history[2], {
      role: "tool",
      callId: "w1",
      name: "write",
      result: {
        status: "error",
        code: "cut_off",
        message: "Not run: the reply was cut off at the output token limit",
      },
    });
  });
}

void test("structured output that used the whole output limit counts as cut off whatever its finish reason", async () => {
  // generateText parses the output itself, so unparsable output fails there,
  // before the adapter sees the reply's usage.
  let requests = 0;
  const provider = new MockLanguageModelV4({
    doGenerate: async () => {
      requests++;
      return {
        content: [{type: "text", text: '{"answer":"unfini'}],
        finishReason: {unified: "stop", raw: "stop"},
        usage: {...usage, outputTokens: {total: 300, text: 300, reasoning: 0}},
        warnings: [],
      };
    },
  });
  const a = agent({
    model: aiModel({model: provider}),
    maxOutputTokens: 300,
    output: z.object({answer: z.string()}),
  });
  const {output} = await runHandler((context: Context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return {failed: false};
        } catch (error) {
          return {terminal: isAgentTerminal(error), message: (error as Error).message};
        }
      })(),
    ),
  );
  assert.equal(output.terminal, true);
  assert.match(output.message, /cut off at the output token limit/);
  // A cut-off is not retried as a schema mismatch.
  assert.equal(requests, 1);
});

void test("maxOutputTokens reaches the provider only when set", async () => {
  const limits: (number | undefined)[] = [];
  const provider = new MockLanguageModelV4({
    doGenerate: async (options) => {
      limits.push(options.maxOutputTokens);
      return {
        content: [{type: "text", text: "done"}],
        finishReason: {unified: "stop", raw: "stop"},
        usage,
        warnings: [],
      };
    },
  });
  const model = aiModel({model: provider});
  await runHandler((context: Context) => r.execute(context, agent({model}).run("go")));
  await runHandler((context: Context) =>
    r.execute(context, agent({model, maxOutputTokens: 2048}).run("go")),
  );
  assert.deepEqual(limits, [undefined, 2048]);
});

void test("live chunks occur only during provider I/O and are not replayed", async () => {
  const live: string[] = [];
  const provider = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          {type: "stream-start", warnings: []},
          {type: "text-start", id: "t"},
          {type: "text-delta", id: "t", delta: "hello"},
          {type: "text-end", id: "t"},
          {type: "finish", finishReason: {unified: "stop", raw: "stop"}, usage},
        ],
      }),
    }),
  });
  const a = agent({
    model: aiModel({
      model: provider,
      async onChunk(chunk) {
        live.push(chunk.type);
      },
    }),
  });
  const handler = (context: Context) =>
    r.execute(
      context,
      (function* () {
        return yield* a.run("go");
      })(),
    );
  const first = await runHandler(handler);
  assert.equal(first.output.output, "hello");
  assert.deepEqual(live, ["start", "text-delta", "finish"]);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(live.length, 3);
});

const failing = (error: Error) => {
  let calls = 0;
  const provider = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      throw error;
    },
  });
  const a = agent({model: aiModel({model: provider})});
  const run = runHandler((context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return {message: "unexpected success", code: 0};
        } catch (e) {
          return {message: String(e), code: (e as TerminalError).code};
        }
      })(),
    ),
  );
  return {run, calls: () => calls};
};
const rejected = (statusCode: number, isRetryable: boolean) =>
  new APICallError({
    message: `status ${statusCode}`,
    url: "https://provider.test",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });

void test("provider failures a retry cannot fix fail the run terminally", async () => {
  const cases = [
    {error: new LoadAPIKeyError({message: "OPENAI_API_KEY is not set"}), message: /OPENAI_API_KEY/},
    {
      error: new UnsupportedFunctionalityError({functionality: "structured outputs"}),
      message: /structured outputs/,
    },
    {error: rejected(400, false), message: /status 400/, code: 400},
  ];
  for (const {error, message, code} of cases) {
    const {run, calls} = failing(error);
    const {output} = await run;
    assert.equal(calls(), 1);
    assert.match(output.message, message);
    if (code) assert.equal(output.code, code);
  }
});

void test("a throttled provider call stays retryable", async () => {
  const {run, calls} = failing(rejected(429, true));
  // The harness surfaces a retryable failure instead of retrying it.
  await assert.rejects(run, /SDK failure.*status 429/);
  assert.equal(calls(), 1);
});
