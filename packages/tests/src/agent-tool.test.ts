import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {channel, execute, gen, type Channel} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, agentTool, tool, type Message, type ModelResponse} from "@restate-agents/core";
import {runHandler} from "./replay-harness.mjs";

function context(): Context {
  return {
    request: () => ({id: "agent-tool", attemptCompletedSignal: new AbortController().signal}),
  } as unknown as Context;
}

const delegate = (id: string, task: string): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name: "research", input: {task}}],
});
const toolResults = (messages: readonly Message[]) =>
  messages.flatMap((message) => (message.role === "tool" ? [message.result] : []));

void test("a sub-agent receives the task and its answer becomes the tool result", async () => {
  const researcher = agent({
    name: "researcher",
    *model(request) {
      assert.deepEqual(request.messages, [{role: "user", content: "Count the sources"}]);
      return {type: "final", text: "42 sources"};
    },
  });
  const lead = agent({
    tools: {research: agentTool(researcher, {description: "Research a question."})},
    *model(request) {
      if (request.step === 1) return delegate("r1", "Count the sources");
      assert.deepEqual(toolResults(request.messages), [{status: "success", output: "42 sources"}]);
      return {type: "final", text: "There are 42 sources."};
    },
  });
  const result = await execute(context(), lead.run("How many sources?"));
  assert.equal(result.status, "completed");
  assert.equal(result.output, "There are 42 sources.");
  // The sub-agent's own conversation stays out of the parent's history.
  assert.equal(result.messages.length, 4);
});

void test("structured sub-agent output reaches the parent as JSON", async () => {
  const counter = agent({
    output: z.object({count: z.number()}),
    *model() {
      return {type: "final", text: JSON.stringify({count: 3})};
    },
  });
  const lead = agent({
    tools: {research: agentTool(counter, {description: "Count things."})},
    *model(request) {
      if (request.step === 1) return delegate("c1", "Count");
      assert.deepEqual(toolResults(request.messages), [{status: "success", output: {count: 3}}]);
      return {type: "final", text: "3"};
    },
  });
  assert.equal((await execute(context(), lead.run("go"))).status, "completed");
});

void test("a sub-agent that runs out of steps is reported to the model as a tool error", async () => {
  const noop = tool({
    description: "fixture",
    input: z.object({}),
    *execute() {
      return null;
    },
  });
  const looping = agent({
    maxSteps: 1,
    tools: {noop},
    *model(): Generator<never, ModelResponse> {
      return {type: "tool_calls", calls: [{id: "n", name: "noop", input: {}}]};
    },
  });
  const lead = agent({
    tools: {research: agentTool(looping, {description: "Never finishes."})},
    *model(request) {
      if (request.step === 1) return delegate("l1", "Loop");
      const [failure] = toolResults(request.messages);
      assert.equal(failure?.status, "error");
      assert.equal(failure?.status === "error" && failure.code, "agent_stopped");
      return {type: "final", text: "The researcher could not finish."};
    },
  });
  assert.equal((await execute(context(), lead.run("go"))).status, "completed");
});

void test("concurrent sub-agents run under distinct names", async () => {
  const names: string[] = [];
  const researcher = agent({
    tools: {
      whoami: tool({
        description: "fixture",
        input: z.object({}),
        *execute(_, toolContext) {
          names.push(toolContext.name);
          return null;
        },
      }),
    },
    *model(request) {
      if (request.step === 1)
        return {type: "tool_calls", calls: [{id: "w", name: "whoami", input: {}}]};
      return {type: "final", text: "done"};
    },
  });
  const lead = agent({
    name: "lead",
    tools: {research: agentTool(researcher, {description: "Research."})},
    *model(request) {
      if (request.step !== 1) return {type: "final", text: "done"};
      return {
        type: "tool_calls",
        calls: [
          {id: "a", name: "research", input: {task: "first"}},
          {id: "b", name: "research", input: {task: "second"}},
        ],
      };
    },
  });
  assert.equal((await execute(context(), lead.run("go"))).status, "completed");
  assert.deepEqual(names.toSorted(), ["lead/a", "lead/b"]);
});

void test("interrupting the parent cancels a running sub-agent", async () => {
  let interrupt!: Channel<string>;
  const researcher = agent({
    tools: {
      wait: tool({
        description: "fixture",
        input: z.object({}),
        *execute() {
          yield* interrupt.send("stop now");
          return yield* channel<null>().receive;
        },
      }),
    },
    *model(): Generator<never, ModelResponse> {
      return {type: "tool_calls", calls: [{id: "w", name: "wait", input: {}}]};
    },
  });
  const lead = agent({
    tools: {research: agentTool(researcher, {description: "Research."})},
    *model(): Generator<never, ModelResponse> {
      return delegate("r1", "Wait forever");
    },
  });
  const result = await execute(
    context(),
    gen(function* () {
      interrupt = channel<string>();
      return yield* lead.run("go", {controls: {interrupt: interrupt.receive}});
    }),
  );
  assert.equal(result.status, "interrupted");
  assert.deepEqual(toolResults(result.messages), [{status: "cancelled", message: "stop now"}]);
});

void test("a sub-agent's model calls are journaled and not repeated on replay", async () => {
  let subCalls = 0;
  const researcher = agent({
    *model() {
      return yield* r.run(
        async () => {
          subCalls++;
          return {type: "final" as const, text: "found it"};
        },
        {name: "sub-model"},
      );
    },
  });
  const lead = agent({
    tools: {research: agentTool(researcher, {description: "Research."})},
    *model(request) {
      if (request.step === 1) return delegate("r1", "Find it");
      return {type: "final", text: "done"};
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, lead.run("go"));
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.equal(subCalls, 1);
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(subCalls, 1);
});
