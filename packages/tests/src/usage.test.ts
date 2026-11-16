import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  AgentLimitError,
  RunInputError,
  tool,
  usageOf,
  type ModelResponse,
  type RunUsage,
} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";

const usage = {
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 60,
  cacheWriteInputTokens: 20,
};
/** The totals of `count` model calls that each report `usage`. */
const totals = (count: number): RunUsage => ({
  inputTokens: 100 * count,
  outputTokens: 10 * count,
  totalTokens: 110 * count,
  cachedInputTokens: 60 * count,
  cacheWriteInputTokens: 20 * count,
});
const final = (text = "Done"): ModelResponse => ({type: "final", text, usage});
const calls = (id: string, name = "read"): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name, input: {}}],
  usage,
});
const delegate = (id: string): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name: "research", input: {task: "Look it up"}}],
  usage,
});
const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "x".repeat(400);
  },
});
const execute = <T>(operation: r.Operation<T>) => r.execute(testContext("usage"), operation);
/** Runs `operation`, which must fail, and returns what it threw with that value's usage. */
function* failure(operation: r.Operation<unknown>) {
  try {
    yield* operation;
  } catch (error) {
    return {error, usage: usageOf(error)};
  }
  throw new Error("Expected the run to fail");
}

void test("run usage sums each call and keeps cache counts inside inputTokens", async () => {
  const a = agent({
    tools: {read},
    *model(request) {
      return request.step === 1 ? calls("r1") : final();
    },
  });
  assert.deepEqual((await execute(a.run("Go"))).usage, totals(2));
});

void test("calls without reported usage add nothing", async () => {
  const partly = agent({
    tools: {read},
    *model(request) {
      return request.step === 1 ? {...calls("r1"), usage: undefined} : final();
    },
  });
  assert.deepEqual((await execute(partly.run("Go"))).usage, totals(1));
  const silent = agent({
    *model() {
      return {type: "final", text: "Done"};
    },
  });
  assert.deepEqual((await execute(silent.run("Go"))).usage, totals(0));
});

void test("each run of one agent definition has its own totals", async () => {
  const a = agent({
    tools: {read},
    *model(request) {
      const [input] = request.messages;
      const reads = input?.role === "user" && input.content === "Read first";
      return reads && request.step === 1 ? calls("r1") : final();
    },
  });
  assert.deepEqual((await execute(a.run("Read first"))).usage, totals(2));
  assert.deepEqual((await execute(a.run("Answer"))).usage, totals(1));
});

void test("in-run compaction is counted, including the cached-prefix attempt", async () => {
  let summaries = 0;
  const a = agent({
    tools: {read},
    compaction: {maxTokens: 650, retainTokens: 300},
    *model(request) {
      if (request.step === undefined) {
        summaries++;
        // A tool call makes the compactor retry without tools after its cached-prefix attempt.
        return request.tools.length ? calls("unused") : final("Summary");
      }
      // Steps report no usage, so the totals hold only the compaction calls.
      if (request.step <= 5) return {...calls(`r${request.step}`), usage: undefined};
      return {type: "final", text: "Done"};
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.ok(summaries >= 2 && summaries % 2 === 0);
  assert.deepEqual(result.usage, totals(summaries));
});

void test("a stopped run counts its summary call, and afterRun sees the totals", async () => {
  let seen: RunUsage | undefined;
  const a = agent({
    maxSteps: 1,
    tools: {read},
    *model(request) {
      return request.tools.length ? calls("r1") : final("Summary");
    },
    *afterRun(candidate) {
      seen = {...candidate.usage};
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.usage, totals(2));
  assert.deepEqual(seen, totals(2));
});

void test("an interrupted run counts its summary call", async () => {
  const result = await execute(
    (function* () {
      const interrupt = r.channel<string>();
      const a = agent({
        *model(request) {
          if (request.step === undefined) return final("Summary");
          yield* interrupt.send("Stop");
          return yield* r.channel<ModelResponse>().receive;
        },
      });
      return yield* a.run("Go", {controls: {interrupt: interrupt.receive}});
    })(),
  );
  assert.equal(result.status, "interrupted");
  assert.deepEqual(result.usage, totals(1));
});

void test("a response dropped for a background result is counted", async () => {
  const result = await execute(
    (function* () {
      const release = r.channel<void>();
      const a = agent({
        tools: {
          wait: tool({
            description: "Wait",
            input: z.object({}),
            background: true,
            *execute() {
              yield* release.receive;
              return "ready";
            },
          }),
        },
        *model(request) {
          if (request.step === 1) return calls("w1", "wait");
          if (request.step === 2) {
            // The result arrives while this response is produced, so the run asks again.
            yield* release.send();
            return final("Stale");
          }
          return final();
        },
      });
      return yield* a.run("Go");
    })(),
  );
  assert.equal(result.output, "Done");
  assert.equal(result.steps, 3);
  assert.deepEqual(result.usage, totals(3));
});

void test("an answer superseded by steering is counted", async () => {
  const result = await execute(
    (function* () {
      const steering = r.channel<string>();
      let reads = 0;
      const a = agent({
        *model() {
          return final();
        },
        *afterRun(candidate) {
          if (candidate.steps === 1) {
            yield* steering.send("Try again");
            yield* r.channel<void>().receive;
          }
        },
      });
      return yield* a.run("Go", {
        controls: {
          steering: () => (reads++ === 0 ? steering.receive : r.channel<string>().receive),
        },
      });
    })(),
  );
  assert.equal(result.steps, 2);
  assert.deepEqual(result.usage, totals(2));
});

for (const ending of ["completed", "stopped"] as const) {
  void test(`a ${ending} sub-agent's usage counts toward the parent`, async () => {
    const researcher = agent({
      maxSteps: 1,
      finalize: false,
      tools: {read},
      *model() {
        return ending === "completed" ? final("Found it") : calls("s1");
      },
    });
    const parent = agent({
      tools: {research: agentTool(researcher, {description: "Research"})},
      *model(request) {
        return request.step === 1 ? delegate("d1") : final();
      },
    });
    const result = await execute(parent.run("Go"));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.usage, totals(3));
  });
}

void test("a sub-agent that fails terminally still counts, and the parent continues", async () => {
  const researcher = agent({
    tools: {read},
    *model(request) {
      if (request.step === 1) return calls("s1");
      throw new TerminalError("Provider unavailable");
    },
  });
  const parent = agent({
    tools: {research: agentTool(researcher, {description: "Research"})},
    *model(request) {
      return request.step === 1 ? delegate("d1") : final();
    },
  });
  const result = await execute(parent.run("Go"));
  assert.equal(result.status, "completed");
  const results = result.messages.flatMap((message) =>
    message.role === "tool" ? [message.result] : [],
  );
  assert.deepEqual(results, [
    {status: "error", code: "tool_failed", message: "Provider unavailable"},
  ]);
  assert.deepEqual(result.usage, totals(3));
});

void test("nested sub-agents that fail the run are counted once in its error", async () => {
  const leaf = agent({
    maxOutputChars: 5,
    *model() {
      return final("Far too long");
    },
  });
  const middle = agent({
    tools: {research: agentTool(leaf, {description: "Research"})},
    *model() {
      return delegate("m1");
    },
  });
  const top = agent({
    tools: {research: agentTool(middle, {description: "Research"})},
    *model() {
      return delegate("t1");
    },
  });
  // AgentLimitError fails each parent instead of becoming a tool result.
  const failed = await execute(failure(top.run("Go")));
  assert.ok(failed.error instanceof AgentLimitError);
  assert.deepEqual(failed.usage, totals(3));
});

void test("a background sub-agent cut off by the parent's step limit still counts", async () => {
  const result = await execute(
    (function* () {
      const started = r.channel<void>();
      const researcher = agent({
        tools: {
          wait: tool({
            description: "Wait",
            input: z.object({}),
            *execute() {
              yield* started.send();
              return yield* r.channel<string>().receive;
            },
          }),
        },
        *model() {
          return calls("s1", "wait");
        },
      });
      const parent = agent({
        maxSteps: 2,
        finalize: false,
        tools: {research: agentTool(researcher, {description: "Research", background: true})},
        *model(request) {
          if (request.step === 1) return delegate("d1");
          // Answer once the sub-agent made its call; the pending call keeps the run open.
          yield* started.receive;
          return final();
        },
      });
      return yield* parent.run("Go");
    })(),
  );
  assert.equal(result.status, "stopped");
  assert.deepEqual(result.usage, totals(3));
});

void test("a failed run's error carries the totals up to the failure", async () => {
  const unavailable = new TerminalError("Provider unavailable");
  const a = agent({
    tools: {read},
    *model(request) {
      if (request.step === 1) return calls("r1");
      throw unavailable;
    },
  });
  const failed = await execute(
    (function* () {
      try {
        yield* a.run("Go");
      } catch (error) {
        const copy = usageOf(error)!;
        copy.inputTokens = 0;
        // usageOf returns a copy, and the run rethrows the error it caught.
        return {same: error === unavailable, usage: usageOf(error)};
      }
      throw new Error("Expected the run to fail");
    })(),
  );
  assert.deepEqual(failed, {same: true, usage: totals(1)});
});

void test("an error before any model call carries zero totals", async () => {
  const a = agent({
    *model() {
      return final();
    },
  });
  const failed = await execute(failure(a.run("")));
  assert.ok(failed.error instanceof RunInputError);
  assert.deepEqual(failed.usage, totals(0));
  assert.equal(usageOf(new Error("Not thrown by a run")), undefined);
  assert.equal(usageOf("not an object"), undefined);
});

void test("replay rebuilds the same totals, including a sub-agent's journaled failure", async () => {
  let modelCalls = 0;
  const researcher = agent({
    tools: {read},
    *model(request) {
      return yield* r.run(
        async (): Promise<ModelResponse> => {
          modelCalls++;
          if (request.step === 1) return calls("s1");
          throw new TerminalError("Provider unavailable");
        },
        {name: `research-${request.step}`},
      );
    },
  });
  const parent = agent({
    tools: {research: agentTool(researcher, {description: "Research"})},
    *model(request) {
      return yield* r.run(
        async () => {
          modelCalls++;
          return request.step === 1 ? delegate("d1") : final();
        },
        {name: `lead-${request.step}`},
      );
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, parent.run("Go"));
  const live = await runHandler(handler);
  assert.deepEqual(live.output.usage, totals(3));
  const liveCalls = modelCalls;
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output.usage, totals(3));
  // The replay reads every model response from the journal.
  assert.equal(modelCalls, liveCalls);
});
