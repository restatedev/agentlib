// A fork copies the parent run from memory, not from the journal: the parent
// keeps a branch point for each step, and a replay rebuilds them by running the
// same steps against journaled model and tool results. These tests check that a
// fork sees the same view live, on full replay, and when an invocation resumes
// from any journal entry.
import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {journaledModel, tool, type ModelRequest, type ModelResponse} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";
import {
  call,
  calls,
  delegate,
  final,
  forkingAgent,
  forkTask,
  isFork,
  largePage,
} from "./fork-fixtures.js";

function journaledLookup(effects: {lookups: number}) {
  return tool({
    description: "Look up an order",
    input: z.object({id: z.string()}),
    *execute({id}) {
      return yield* r.run(
        async () => {
          effects.lookups++;
          return `order ${id}: shipped`;
        },
        {name: "lookup"},
      );
    },
  });
}

void test("a fork's model and tool calls are reused on journal replay", async () => {
  const effects = {models: 0, lookups: 0};
  const script = (request: ModelRequest): ModelResponse => {
    if (isFork(request)) {
      if (request.step === 1) return call("f1", "lookup", {id: "8"});
      return final("Order 8 has shipped.");
    }
    if (request.step === 1) return call("p1", "lookup", {id: "7"});
    if (request.step === 2) return delegate("d1", "Check order 8");
    return final("Both shipped.");
  };
  const a = forkingAgent({
    tools: {lookup: journaledLookup(effects)},
    model: journaledModel(async (request) => {
      effects.models++;
      return script(request);
    }),
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("Where are 7 and 8?"));
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.deepEqual(effects, {models: 5, lookups: 2});
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.deepEqual(effects, {models: 5, lookups: 2});
});

void test("a run resumed from any journal entry gives its forks the same view", async () => {
  const effects = {lookups: 0};
  // The first request of each fork that this handler attempt computed itself.
  let firstRequests = new Map<string, ModelRequest>();
  const script = (request: ModelRequest): ModelResponse => {
    if (isFork(request)) {
      const task = forkTask(request)!;
      if (request.step === 1) {
        firstRequests.set(task, structuredClone(request));
        return calls(
          {id: `${task}-lookup`, name: "lookup", input: {id: task}},
          {id: `${task}-weather`, name: "weather", input: {city: task}},
        );
      }
      return final(`checked ${task}`);
    }
    // A previewed page, a journaled search, and forks from a program in parallel.
    if (request.step === 1)
      return calls(
        {id: "page", name: "fetch_page"},
        {id: "search", name: "search_tools", input: {query: "weather"}},
      );
    if (request.step === 2)
      return call("p", "run_program", {
        source:
          "return await Promise.all([tools.delegate({task: 'Ghent'}), tools.delegate({task: 'Berlin'})]);",
      });
    return final("Done");
  };
  const a = forkingAgent({
    tools: {
      lookup: journaledLookup(effects),
      fetch_page: tool({
        description: "Fetch a page",
        input: z.object({}),
        *execute() {
          return largePage;
        },
      }),
      weather: tool({
        description: "Current weather in a city",
        deferred: true,
        input: z.object({city: z.string()}),
        *execute({city}) {
          return `${city}: sunny`;
        },
      }),
    },
    model: journaledModel(async (request) => script(request)),
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("Check Ghent and Berlin"));

  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.deepEqual(live.output.output, "Done");
  const liveRequests = firstRequests;
  assert.deepEqual([...liveRequests.keys()].toSorted(), ["Berlin", "Ghent"]);

  let recomputed = 0;
  for (let entries = 1; entries < live.journal.length; entries++) {
    firstRequests = new Map();
    const resumed = await runHandler(handler, {replay: live.journal.slice(0, entries)});
    assert.deepEqual(resumed.output, live.output, `resumed after ${entries} entries`);
    for (const [task, request] of firstRequests) {
      assert.deepEqual(request, liveRequests.get(task), `fork ${task} after ${entries} entries`);
      recomputed++;
    }
  }
  // Some resumptions replayed the parent's steps and then asked a fork's first
  // question live, from the view the replay rebuilt.
  assert.ok(recomputed > 0);
});
