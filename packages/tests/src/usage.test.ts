import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, handoff, tool, type Model, type RunUsage} from "@restatedev/agentlib";
import {testContext} from "./helpers.js";

const usage = {
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 60,
  cacheWriteInputTokens: 20,
};
const totals: RunUsage = {...usage, totalTokens: 110};
const final = {type: "final" as const, text: "Done", usage};
const calls = (id: string, name = "read") => ({
  type: "tool_calls" as const,
  calls: [{id, name, input: {}}],
  usage,
});
const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "x".repeat(400);
  },
});

void test("run usage sums planning and cache counts without counting cache tokens twice", async () => {
  const a = agent({
    tools: {read},
    *model(request) {
      return request.step === 1 ? calls("r1") : final;
    },
    *afterRun(candidate) {
      assert.deepEqual(candidate.usage, {
        inputTokens: 200,
        outputTokens: 20,
        totalTokens: 220,
        cachedInputTokens: 120,
        cacheWriteInputTokens: 40,
      });
      // Even an untyped policy cannot rewrite the run's accounting.
      (candidate.usage as RunUsage).inputTokens = 999;
      return {output: "Reviewed"};
    },
  });
  const result = await r.execute(testContext(), a.run("Go"));
  assert.equal(result.output, "Reviewed");
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.totalTokens, 220);
});

void test("usage is isolated across concurrent and sequential runs of one definition", async () => {
  const secondUsage = {
    inputTokens: 20,
    outputTokens: 3,
    cachedInputTokens: 7,
    cacheWriteInputTokens: 2,
  };
  const secondTotals = {...secondUsage, totalTokens: 23};
  const results = await r.execute(
    testContext(),
    (function* () {
      const firstStarted = r.channel<void>();
      const secondStarted = r.channel<void>();
      const releaseFirst = r.channel<void>();
      const releaseSecond = r.channel<void>();
      const a = agent({
        *model(request) {
          const input = request.messages.at(-1);
          assert.equal(input?.role, "user");
          if (input?.role === "user" && input.content === "First") {
            yield* firstStarted.send();
            yield* releaseFirst.receive;
          }
          if (input?.role === "user" && input.content === "Second") {
            yield* secondStarted.send();
            yield* releaseSecond.receive;
            return {...final, usage: secondUsage};
          }
          return final;
        },
      });
      const first = r.spawn(a.run("First"));
      const second = r.spawn(a.run("Second"));
      // Both model calls must start before either can finish.
      yield* firstStarted.receive;
      yield* secondStarted.receive;
      yield* releaseSecond.send();
      const secondResult = yield* second;
      assert.deepEqual(secondResult.usage, secondTotals);
      yield* releaseFirst.send();
      const firstResult = yield* first;
      const thirdResult = yield* a.run("Third", {messages: firstResult.messages});
      return [firstResult, secondResult, thirdResult];
    })(),
  );
  assert.deepEqual(
    results.map((result) => result.usage),
    [totals, secondTotals, totals],
  );
  results[0]!.usage.inputTokens = 999;
  assert.deepEqual(results[1]!.usage, secondTotals);
  assert.deepEqual(results[2]!.usage, totals);
});

void test("only reported usage contributes to the totals", async () => {
  const a = agent({
    tools: {read},
    *model(request) {
      if (request.step === 1) return {...calls("r1"), usage: undefined};
      return final;
    },
  });
  assert.deepEqual((await r.execute(testContext(), a.run("Go"))).usage, totals);
  const missing = agent({
    *model() {
      return {type: "final", text: "Done"};
    },
  });
  assert.deepEqual((await r.execute(testContext(), missing.run("Go"))).usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
});

void test("schema repair and handoff keep all reported usage in the same run", async () => {
  const target = agent({
    *model(request) {
      return {...final, text: request.step === 2 ? "invalid JSON" : '{"ok":true}'};
    },
  });
  const a = agent({
    output: z.object({ok: z.boolean()}),
    tools: {transfer: handoff(target)},
    *model() {
      return calls("transfer", "transfer");
    },
  });
  const result = await r.execute(testContext(), a.run("Go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, {ok: true});
  assert.deepEqual(result.usage, {
    inputTokens: 300,
    outputTokens: 30,
    totalTokens: 330,
    cachedInputTokens: 180,
    cacheWriteInputTokens: 60,
  });
});

for (const ending of ["summary", "invalid-summary", "failed-summary", "no-summary"] as const) {
  void test(`stopped usage includes finalization: ${ending}`, async () => {
    const finalize: Model | false =
      ending === "no-summary"
        ? false
        : function* () {
            if (ending === "failed-summary") throw new TerminalError("Unavailable");
            return ending === "invalid-summary" ? calls("not-allowed") : final;
          };
    const a = agent({
      maxSteps: 1,
      tools: {read},
      *model() {
        return calls("r1");
      },
      finalize,
      *afterRun(candidate) {
        assert.equal(
          candidate.usage.totalTokens,
          ending === "summary" || ending === "invalid-summary" ? 220 : 110,
        );
      },
    });
    const result = await r.execute(testContext(), a.run("Go"));
    assert.equal(result.status, "stopped");
    assert.equal(
      result.usage.totalTokens,
      ending === "summary" || ending === "invalid-summary" ? 220 : 110,
    );
  });
}

void test("compaction counts both the cached-prefix attempt and its fallback", async () => {
  let summaries = 0;
  const a = agent({
    tools: {read},
    compaction: {maxTokens: 650, retainTokens: 300},
    *model(request) {
      // Make the compactor retry tool-free after its cached-prefix attempt.
      if (request.step === undefined) {
        summaries++;
        return request.tools.length ? calls("unused") : final;
      }
      // No input usage measurement: message growth triggers compaction.
      if (request.step <= 5) return {...calls(`r${request.step}`), usage: undefined};
      return {...final, usage: undefined};
    },
  });
  const result = await r.execute(testContext(), a.run("Go"));
  assert.equal(result.status, "completed");
  assert.ok(summaries >= 2);
  assert.equal(summaries % 2, 0);
  assert.equal(result.usage.inputTokens, summaries * 100);
  assert.equal(result.usage.outputTokens, summaries * 10);
  assert.equal(result.usage.cachedInputTokens, summaries * 60);
});

void test("responses discarded when background work completes still count", async () => {
  const result = await r.execute(
    testContext(),
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
            yield* release.send();
            return {...final, text: "Stale"};
          }
          return final;
        },
      });
      return yield* a.run("Go");
    })(),
  );
  assert.equal(result.output, "Done");
  assert.equal(result.steps, 3);
  assert.equal(result.usage.totalTokens, 330);
});

void test("steering during output review preserves the discarded response's usage", async () => {
  const result = await r.execute(
    testContext(),
    (function* () {
      const steering = r.channel<string>();
      let reads = 0;
      const a = agent({
        *model() {
          return final;
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
  assert.equal(result.usage.totalTokens, 220);
});

void test("an interrupted run includes usage from its final summary", async () => {
  const result = await r.execute(
    testContext(),
    (function* () {
      const interrupt = r.channel<string>();
      const a = agent({
        *model() {
          yield* interrupt.send("Stop");
          yield* r.channel<void>().receive;
          return final;
        },
        *finalize() {
          return final;
        },
      });
      return yield* a.run("Go", {controls: {interrupt: interrupt.receive}});
    })(),
  );
  assert.equal(result.status, "interrupted");
  assert.deepEqual(result.usage, totals);
});
