import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context, TerminalError} from "@restatedev/restate-sdk";
import {APICallError, LoadAPIKeyError, UnsupportedFunctionalityError} from "ai";
import * as r from "@restatedev/restate-sdk-gen";
import {MockLanguageModelV4, simulateReadableStream} from "ai/test";
import {z} from "zod";
import {agent, handoff, tool, type ModelResponse} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";
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

void test("a provider tool-calls finish reason without calls cannot become a final answer", async () => {
  const provider = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{type: "text", text: "apparently complete"}],
      finishReason: {unified: "tool-calls", raw: "tool_calls"},
      usage,
      warnings: [],
    }),
  });
  const a = agent({model: aiModel({model: provider})});
  const result = await runHandler((context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return "unexpected success";
        } catch (error) {
          return String(error);
        }
      })(),
    ),
  );
  assert.match(result.output, /indicated tool calls but returned none/);
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

void test("provider truncation fails even when the response text is otherwise valid", async () => {
  const provider = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{type: "text", text: "partial"}],
      finishReason: {unified: "length", raw: "length"},
      usage,
      warnings: [],
    }),
  });
  const a = agent({model: aiModel({model: provider})});
  const first = await runHandler((context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return {failed: false};
        } catch (e) {
          return {failed: true, message: String(e)};
        }
      })(),
    ),
  );
  assert.equal(first.output.failed, true);
  assert.match(first.output.message, /Incomplete model response: length/);
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
