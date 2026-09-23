import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {MockLanguageModelV4, simulateReadableStream} from "ai/test";
import {z} from "zod";
import {agent, handoff, tool, type ModelResponse} from "@restate-agents/core";
import {aiModel} from "@restate-agents/core/provider";
import {runHandler} from "./replay-harness.mjs";
const ctx = () =>
  ({
    request: () => ({id: "compose", attemptCompletedSignal: new AbortController().signal}),
  }) as unknown as Context;
const usage = {
  inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0},
  outputTokens: {total: 1, text: 1, reasoning: 0},
};
const done: ModelResponse = {type: "final", text: "done"};

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

void test("live chunks occur only during provider I/O while recorded chunks reconstruct on replay", async () => {
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
      includeChunks: true,
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
