// Forked sub-agents that use tools. A fork is a copy of the parent run as it
// stood at the step that called the fork tool: the same agents, policies,
// run-level tools, and loaded deferred tools, and the full history behind the
// messages it inherits. It keeps its own executor, budget, and background work.
// These tests check what a fork copies and what stays with the parent.
import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {channel, gen, type Channel} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  cancelOperationTool,
  forkTool,
  handoff,
  tool,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ToolResult,
} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";
import {
  call,
  calls,
  delegate,
  execute,
  final,
  forkingAgent,
  forkTask,
  inherited,
  isFork,
  largePage,
  PREAMBLE,
  resultOf,
  toolNames,
} from "./fork-fixtures.js";

function lookupTool(looked: string[] = []) {
  return tool({
    description: "Look up an order",
    input: z.object({id: z.string()}),
    *execute({id}) {
      looked.push(id);
      return `order ${id}: shipped`;
    },
  });
}
const fetchPage = tool({
  description: "Fetch a page",
  input: z.object({}),
  *execute() {
    return largePage;
  },
});
const weather = tool({
  description: "Current weather in a city",
  deferred: true,
  input: z.object({city: z.string()}),
  *execute({city}) {
    return `${city}: sunny`;
  },
});
function writeTool(written: string[]) {
  return tool({
    description: "Write a file",
    input: z.object({path: z.string()}),
    *execute({path}) {
      written.push(path);
      return "written";
    },
  });
}

// --- A fork's own tools ---------------------------------------------------

void test("a fork calls its own tools, and only its answer reaches the parent", async () => {
  const looked: string[] = [];
  let forkSawParentResult: ToolResult | undefined;
  const a = forkingAgent({
    tools: {lookup: lookupTool(looked)},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) {
          forkSawParentResult = resultOf(request.messages, "p1");
          return call("f1", "lookup", {id: "8"});
        }
        assert.deepEqual(resultOf(request.messages, "f1"), {
          status: "success",
          output: "order 8: shipped",
        });
        return final("Order 8 has shipped too.");
      }
      if (request.step === 1) return call("p1", "lookup", {id: "7"});
      if (request.step === 2) return delegate("d1", "Check order 8");
      return final("Both shipped.");
    },
  });
  const result = await execute(a.run("Where are orders 7 and 8?"));
  assert.equal(result.status, "completed");
  // The fork builds on the parent's result instead of looking it up again.
  assert.deepEqual(forkSawParentResult, {status: "success", output: "order 7: shipped"});
  assert.deepEqual(looked, ["7", "8"]);
  assert.deepEqual(resultOf(result.messages, "d1"), {
    status: "success",
    output: "Order 8 has shipped too.",
  });
  // The fork's own exchange stays in the fork.
  assert.equal(resultOf(result.messages, "f1"), undefined);
  assert.equal(JSON.stringify(result.messages).includes(PREAMBLE), false);
});

void test("parallel forks start from the same view and do not see each other's calls", async () => {
  const forks = new Map<string, ModelRequest[]>();
  const a = forkingAgent({
    tools: {lookup: lookupTool()},
    script(request) {
      if (isFork(request)) {
        const task = forkTask(request)!;
        forks.set(task, [...(forks.get(task) ?? []), structuredClone(request)]);
        if (request.step === 1) return call(`${task}-1`, "lookup", {id: task});
        return final(`checked ${task}`);
      }
      if (request.step === 1) return call("p1", "lookup", {id: "7"});
      if (request.step === 2)
        return calls(
          {id: "d1", name: "delegate", input: {task: "8"}},
          {id: "d2", name: "delegate", input: {task: "9"}},
        );
      return final("Done");
    },
  });
  const result = await execute(a.run("Check orders 7, 8 and 9"));
  assert.equal(result.status, "completed");
  const eight = forks.get("8")!;
  const nine = forks.get("9")!;
  assert.deepEqual(inherited(eight[0]!), inherited(nine[0]!));
  assert.ok(resultOf(eight[1]!.messages, "8-1"));
  assert.equal(resultOf(eight[1]!.messages, "9-1"), undefined);
  assert.equal(resultOf(nine[1]!.messages, "8-1"), undefined);
  assert.deepEqual(resultOf(result.messages, "d1"), {status: "success", output: "checked 8"});
  assert.deepEqual(resultOf(result.messages, "d2"), {status: "success", output: "checked 9"});
});

void test("forks started from a program inherit the view of the step that ran it", async () => {
  const forkViews: Message[][] = [];
  let programStep: Message[] = [];
  const a = forkingAgent({
    tools: {lookup: lookupTool()},
    script(request) {
      if (isFork(request)) {
        forkViews.push(inherited(request));
        return final(`did ${forkTask(request)}`);
      }
      if (request.step === 1) {
        programStep = structuredClone(request.messages);
        return call("p", "run_program", {
          source:
            "return await Promise.all([tools.delegate({task: 'A'}), tools.delegate({task: 'B'})]);",
        });
      }
      return final("Done");
    },
  });
  const result = await execute(a.run("Do A and B"));
  assert.equal(result.status, "completed");
  assert.deepEqual(resultOf(result.messages, "p"), {
    status: "success",
    output: ["did A", "did B"],
  });
  assert.equal(forkViews.length, 2);
  for (const view of forkViews) assert.deepEqual(view, programStep);
});

void test("a fork's program cannot fork again", async () => {
  let nested: ToolResult | undefined;
  const a = forkingAgent({
    tools: {lookup: lookupTool()},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1)
          return call("fp", "run_program", {
            source: "return await tools.delegate({task: 'deeper'});",
          });
        nested = resultOf(request.messages, "fp");
        return final("did it myself");
      }
      if (request.step === 1) return delegate("d1", "Subtask");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(nested?.status, "error");
  assert.match(nested.message, /cannot start forks or sub-agents/);
});

void test("a fork cannot start sub-agents, directly or from a program", async () => {
  const workerTasks: string[] = [];
  const worker = agent({
    *model(request) {
      const input = request.messages.find((message) => message.role === "user");
      if (input?.role === "user") workerTasks.push(input.content);
      return final("worked");
    },
  });
  let direct: ToolResult | undefined;
  let program: ToolResult | undefined;
  const a = forkingAgent({
    tools: {research: agentTool(worker, {description: "Research a topic"})},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1)
          return calls(
            {id: "fr", name: "research", input: {task: "From the fork"}},
            {
              id: "fp",
              name: "run_program",
              input: {source: "return await tools.research({task: 'From the fork program'});"},
            },
          );
        direct = resultOf(request.messages, "fr");
        program = resultOf(request.messages, "fp");
        return final("did it myself");
      }
      if (request.step === 1) return call("pr", "research", {task: "From the parent"});
      if (request.step === 2) return delegate("d1", "Subtask");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  // The parent delegates as usual; only the fork is held to one level.
  assert.deepEqual(resultOf(result.messages, "pr"), {status: "success", output: "worked"});
  assert.deepEqual(workerTasks, ["From the parent"]);
  assert.equal(direct?.status === "error" && direct.code, "fork_nested");
  assert.equal(program?.status, "error");
  assert.match(program.message, /cannot start forks or sub-agents/);
});

void test("a fork previews its own large results and reads them back", async () => {
  let read: ToolResult | undefined;
  const a = forkingAgent({
    tools: {fetch_page: fetchPage},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("g1", "fetch_page");
        if (request.step === 2) {
          assert.match(JSON.stringify(resultOf(request.messages, "g1")), /tool-result-preview/);
          return call("x1", "read_tool_result", {ref: "g1", offset: 20000, limit: 100});
        }
        read = resultOf(request.messages, "x1");
        return final("read it");
      }
      if (request.step === 1) return delegate("d1", "Fetch the page and find line 2500");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(read, {
    status: "success",
    output: {
      ref: "g1",
      offset: 20000,
      text: largePage.slice(20000, 20100),
      totalChars: largePage.length,
      nextOffset: 20100,
    },
  });
});

void test("a fork's approval requests are published once, to the policy and the run's handler", async () => {
  const published: string[] = [];
  const policyPublished: string[] = [];
  let refund: ToolResult | undefined;
  const a = forkingAgent({
    tools: {
      refund: tool({
        description: "Refund an order",
        input: z.object({}),
        needsApproval: true,
        *execute() {
          return "refunded";
        },
      }),
    },
    *onApproval(request) {
      policyPublished.push(request.signalName);
    },
    *onHumanApproval() {
      return true;
    },
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("x", "refund");
        refund = resultOf(request.messages, "x");
        return final("Refunded.");
      }
      if (request.step === 1) return delegate("d1", "Refund the order");
      return final("Done.");
    },
  });
  const result = await execute(
    a.run("Refund it", {
      *onApproval(request) {
        published.push(request.signalName);
      },
    }),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(refund, {status: "success", output: "refunded"});
  // The fork runs under the delegate call's name, so its signals do not collide.
  assert.deepEqual(published, ["agent/d1:approval:x:0"]);
  assert.deepEqual(policyPublished, ["agent/d1:approval:x:0"]);
});

void test("interrupting the parent cancels a running fork and its tool", async () => {
  let interrupt!: Channel<string>;
  let unwound = false;
  const a = forkingAgent({
    tools: {
      wait: tool({
        description: "Wait for a long job",
        input: z.object({}),
        *execute() {
          try {
            yield* interrupt.send("stop now");
            return yield* channel<null>().receive;
          } finally {
            unwound = true;
          }
        },
      }),
    },
    script(request) {
      if (isFork(request)) return call("w", "wait");
      return delegate("d1", "Wait for the job");
    },
  });
  const result = await execute(
    gen(function* () {
      interrupt = channel<string>();
      return yield* a.run("Go", {controls: {interrupt: interrupt.receive}});
    }),
  );
  assert.equal(result.status, "interrupted");
  assert.deepEqual(resultOf(result.messages, "d1"), {status: "cancelled", message: "stop now"});
  assert.equal(unwound, true);
});

void test("the agent's tool policies also check the fork's tool calls", async () => {
  const written: string[] = [];
  let forkWrite: ToolResult | undefined;
  const a = forkingAgent({
    tools: {write: writeTool(written)},
    *beforeTool(toolCall) {
      if (toolCall.name === "write") return "Writes are not allowed";
    },
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("fw", "write", {path: "notes.md"});
        forkWrite = resultOf(request.messages, "fw");
        return final("Could not write.");
      }
      if (request.step === 1) return delegate("d1", "Write the notes");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(forkWrite, {status: "denied", message: "Writes are not allowed"});
  assert.deepEqual(written, []);
});

void test("a fork can call a deferred tool the parent loaded without searching again", async () => {
  let forkWeather: ToolResult | undefined;
  const a = forkingAgent({
    tools: {weather},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("fw", "weather", {city: "Berlin"});
        forkWeather = resultOf(request.messages, "fw");
        return final("Berlin: sunny");
      }
      if (request.step === 1) return call("s1", "search_tools", {query: "weather"});
      if (request.step === 2) return call("w1", "weather", {city: "Ghent"});
      if (request.step === 3) return delegate("d1", "Check Berlin");
      return final("Done");
    },
  });
  // Search journals its ranking, so this run needs a journal.
  const {output} = await runHandler((ctx: Context) => r.execute(ctx, a.run("Weather?")));
  assert.equal(output.status, "completed");
  assert.deepEqual(forkWeather, {status: "success", output: "Berlin: sunny"});
});

void test("a fork sees the parent's pending background call, but cannot cancel it", async () => {
  let forkSawPending: ToolResult | undefined;
  let forkCancel: ToolResult | undefined;
  const result = await execute(
    gen(function* () {
      const never = channel<void>();
      const a = forkingAgent({
        tools: {
          wait: tool({
            description: "Wait for a long job",
            input: z.object({}),
            background: true,
            *execute() {
              yield* never.receive;
              return "finished";
            },
          }),
          cancel_operation: cancelOperationTool(),
        },
        script(request) {
          if (isFork(request)) {
            if (request.step === 1) {
              forkSawPending = resultOf(request.messages, "w1");
              return call("c1", "cancel_operation", {operationId: "w1", reason: null});
            }
            forkCancel = resultOf(request.messages, "c1");
            return final("Could not cancel the job.");
          }
          if (request.step === 1) return call("w1", "wait");
          if (request.step === 2) return delegate("d1", "Cancel the long job");
          if (request.step === 3)
            return call("c2", "cancel_operation", {operationId: "w1", reason: null});
          return final("Done");
        },
      });
      return yield* a.run("Go");
    }),
  );
  assert.equal(result.status, "completed");
  // The operation belongs to the parent run: the fork can neither cancel it nor
  // receive its result, although its history shows it as pending.
  assert.deepEqual(forkSawPending, {status: "pending", operationId: "w1"});
  assert.equal(forkCancel?.status, "error");
  assert.equal(forkCancel.code, "unknown_operation");
  assert.deepEqual(resultOf(result.messages, "c2"), {status: "success", output: {cancelled: true}});
});

void test("a background fork that starts right away inherits the delegating step's view", async () => {
  let delegating: Message[] = [];
  let forkView: Message[] = [];
  let parentSawResult = false;
  const a = forkingAgent({
    tools: {lookup: lookupTool()},
    forkOptions: {background: true},
    script(request) {
      if (isFork(request)) {
        forkView = inherited(request);
        return final("fork done");
      }
      if (request.step === 1) {
        delegating = structuredClone(request.messages);
        return delegate("d1", "Subtask");
      }
      if (request.step === 2) return call("p2", "lookup", {id: "7"});
      parentSawResult ||= JSON.stringify(request.messages).includes("fork done");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  // The fork starts from the step that called it, not the parent's later steps.
  assert.deepEqual(forkView, delegating);
  assert.equal(parentSawResult, true);
});

// --- Run state a fork copies ----------------------------------------------

void test("a fork reads the full text of a result the parent saw as a preview", async () => {
  let inheritedPreview: ToolResult | undefined;
  let read: ToolResult | undefined;
  const a = forkingAgent({
    tools: {fetch_page: fetchPage},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) {
          inheritedPreview = resultOf(request.messages, "f1");
          return call("x1", "read_tool_result", {ref: "f1", offset: 20000, limit: 100});
        }
        read = resultOf(request.messages, "x1");
        return final("read it");
      }
      if (request.step === 1) return call("f1", "fetch_page");
      if (request.step === 2) return delegate("d1", "Find line 2500");
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  // The fork inherits the preview the parent's model saw, which is right for the cache.
  assert.match(JSON.stringify(inheritedPreview), /tool-result-preview/);
  // Reading the rest must return the page, not the preview the fork inherited.
  assert.equal(read?.status, "success");
  const output = read.output as {text: string; totalChars: number};
  assert.equal(output.totalChars, largePage.length);
  assert.equal(output.text, largePage.slice(20000, 20100));
});

void test("a fork lists the deferred tools the parent loaded", async () => {
  let parentTools: string[] = [];
  let forkTools: string[] = [];
  const a = forkingAgent({
    tools: {weather},
    script(request) {
      if (isFork(request)) {
        forkTools = toolNames(request);
        return final("fork done");
      }
      if (request.step === 1) return call("s1", "search_tools", {query: "weather"});
      if (request.step === 2) return call("w1", "weather", {city: "Ghent"});
      if (request.step === 3) {
        parentTools = toolNames(request);
        return delegate("d1", "Check Berlin");
      }
      return final("Done");
    },
  });
  const {output} = await runHandler((ctx: Context) => r.execute(ctx, a.run("Weather?")));
  assert.equal(output.status, "completed");
  assert.ok(parentTools.includes("weather"));
  // Tools precede messages in the cached prefix: a different list misses the cache.
  assert.deepEqual(forkTools, parentTools);
});

void test("a fork can use the run-level tools the parent was started with", async () => {
  let parentTools: string[] = [];
  let forkTools: string[] = [];
  let forkLookup: ToolResult | undefined;
  const a = forkingAgent({
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) {
          forkTools = toolNames(request);
          return call("f1", "lookup", {id: "8"});
        }
        forkLookup = resultOf(request.messages, "f1");
        return final("fork done");
      }
      if (request.step === 1) return call("p1", "lookup", {id: "7"});
      if (request.step === 2) {
        parentTools = toolNames(request);
        return delegate("d1", "Check order 8");
      }
      return final("Done");
    },
  });
  const result = await execute(a.run("Go", {tools: {lookup: lookupTool()}}));
  assert.equal(result.status, "completed");
  assert.deepEqual(forkTools, parentTools);
  assert.deepEqual(forkLookup, {status: "success", output: "order 8: shipped"});
});

void test("a background fork starts from the view of the step that delegated", async () => {
  let delegating: Message[] = [];
  let forkView: Message[] = [];
  const result = await execute(
    gen(function* () {
      const gate = channel<void>();
      const a = forkingAgent({
        tools: {lookup: lookupTool()},
        forkOptions: {background: true, needsApproval: true},
        // The approval arrives once the parent has moved on to its next step.
        *onHumanApproval() {
          yield* gate.receive;
          return true;
        },
        *script(request): Generator<unknown, ModelResponse> {
          if (isFork(request)) {
            forkView = inherited(request);
            return final("fork done");
          }
          if (request.step === 1) {
            delegating = structuredClone(request.messages);
            return delegate("d1", "Subtask");
          }
          if (request.step === 2) {
            yield* gate.send();
            return call("p2", "lookup", {id: "7"});
          }
          return final("Done");
        },
      });
      return yield* a.run("Go");
    }),
  );
  assert.equal(result.status, "completed");
  // The fork starts from the step that called it, even when it starts later.
  assert.deepEqual(forkView, delegating);
});

void test("a fork of a handed-off specialist keeps the root agent's tool policies", async () => {
  const written: string[] = [];
  let parentWrite: ToolResult | undefined;
  let forkWrite: ToolResult | undefined;
  const billing = forkingAgent({
    name: "billing",
    tools: {write: writeTool(written)},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("fw", "write", {path: "refund.md"});
        forkWrite = resultOf(request.messages, "fw");
        return final("fork done");
      }
      // These requests continue the lead's run after the handoff.
      if (!resultOf(request.messages, "bw")) return call("bw", "write", {path: "refund.md"});
      if (!resultOf(request.messages, "d1")) {
        parentWrite = resultOf(request.messages, "bw");
        return delegate("d1", "Write the refund note");
      }
      return final("Done");
    },
  });
  const lead = agent({
    tools: {billing: handoff(billing)},
    *beforeTool(toolCall) {
      if (toolCall.name === "write") return "Writes need a ticket";
    },
    *model() {
      return call("h1", "billing");
    },
  });
  const result = await execute(lead.run("Refund order 7"));
  assert.equal(result.status, "completed");
  // After the handoff the lead's policy still checks the specialist's calls...
  assert.deepEqual(parentWrite, {status: "denied", message: "Writes need a ticket"});
  // ...and in a fork, which copies the run's root and active agent.
  assert.deepEqual(forkWrite, {status: "denied", message: "Writes need a ticket"});
  assert.deepEqual(written, []);
});

void test("a fork reads a result the parent's compaction folded into its note", async () => {
  let delegating: ModelRequest | undefined;
  let read: ToolResult | undefined;
  const a = forkingAgent({
    tools: {
      fetch_page: fetchPage,
      pages: tool({
        description: "Read a page",
        input: z.object({}),
        *execute() {
          return "x".repeat(400);
        },
      }),
    },
    codeMode: false,
    // Small previews, so the page's preview is folded with the other reads.
    toolResults: {maxTokens: 300, previewTokens: 100},
    compaction: {
      // The parent compacts at step 5, folding the page; the fork stays below the limit.
      maxTokens: 1400,
      retainTokens: 300,
      *model() {
        return final("Fetched the page (ref f1) and read two pages of x.");
      },
    },
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) {
          assert.equal(resultOf(request.messages, "f1"), undefined);
          return call("x1", "read_tool_result", {ref: "f1", offset: 20000, limit: 100});
        }
        read = resultOf(request.messages, "x1");
        return final("read it");
      }
      if (request.step === 1) return call("f1", "fetch_page");
      if ((request.step ?? 1) <= 5) return call(`r${request.step}`, "pages");
      if (request.step === 6) {
        delegating = structuredClone(request);
        return delegate("d1", "Find line 2500");
      }
      return final("Done");
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(resultOf(delegating!.messages, "f1"), undefined, "the parent folded f1");
  assert.equal(read?.status, "success");
  assert.equal((read.output as {text: string}).text, largePage.slice(20000, 20100));
});

void test("forkTool runs at most maxConcurrent forks of a run at once", async () => {
  let release!: Channel<void>;
  const a = forkingAgent({
    tools: {
      hold: tool({
        description: "Wait for the signal",
        input: z.object({}),
        *execute() {
          yield* release.receive;
          return "released";
        },
      }),
    },
    forkOptions: {maxConcurrent: 2},
    script(request) {
      if (isFork(request)) {
        const task = forkTask(request)!;
        // The first two forks hold their slots until the third call has been refused.
        if (request.step === 1 && task !== "D") return call(`${task}-hold`, "hold");
        return final(`done ${task}`);
      }
      if (request.step === 1)
        return calls(
          {id: "d1", name: "delegate", input: {task: "A"}},
          {id: "d2", name: "delegate", input: {task: "B"}},
          {id: "d3", name: "delegate", input: {task: "C"}},
        );
      if (request.step === 2) return delegate("d4", "D");
      return final("Done");
    },
  });
  const result = await execute(
    gen(function* () {
      release = channel<void>();
      return yield* a.run("Go", {
        *onProgress(event) {
          if (event.type === "tool-end" && event.callId === "d3") {
            yield* release.send();
            yield* release.send();
          }
        },
      });
    }),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(resultOf(result.messages, "d1"), {status: "success", output: "done A"});
  assert.deepEqual(resultOf(result.messages, "d2"), {status: "success", output: "done B"});
  const refused = resultOf(result.messages, "d3");
  assert.equal(refused?.status === "error" && refused.code, "fork_limit");
  // Finished forks free their slots.
  assert.deepEqual(resultOf(result.messages, "d4"), {status: "success", output: "done D"});
});

void test("maxConcurrent must be a positive integer", () => {
  assert.throws(() => forkTool({maxConcurrent: 0}), /maxConcurrent/);
});

void test("a run's usage is the sum of every model call, including forks that fail", async () => {
  const reported: ModelUsage[] = [];
  let n = 0;
  // Distinct numbers per call, so a call counted twice or missed changes the totals.
  const usage = (): ModelUsage => {
    n++;
    const one = {
      inputTokens: 100 * n,
      outputTokens: n,
      cachedInputTokens: 10 * n,
      cacheWriteInputTokens: n,
    };
    reported.push(one);
    return one;
  };
  const a = forkingAgent({
    tools: {lookup: lookupTool()},
    script(request): ModelResponse {
      if (isFork(request)) {
        const task = forkTask(request)!;
        if (request.step === 1) return {...call(`${task}-1`, "lookup", {id: task}), usage: usage()};
        // A failed model call reports nothing; the fork's earlier calls still count.
        if (task === "fails") throw new TerminalError("The model refused");
        return {...final(`checked ${task}`), usage: usage()};
      }
      if (request.step === 1)
        return {
          ...calls(
            {id: "d1", name: "delegate", input: {task: "ok"}},
            {id: "d2", name: "delegate", input: {task: "fails"}},
          ),
          usage: usage(),
        };
      return {...final("Done"), usage: usage()};
    },
  });
  const result = await execute(a.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(resultOf(result.messages, "d2")?.status, "error");
  const sum = (key: keyof ModelUsage) =>
    reported.reduce((total, one) => total + (one[key] ?? 0), 0);
  assert.equal(reported.length, 5);
  assert.deepEqual(result.usage, {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("inputTokens") + sum("outputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    cacheWriteInputTokens: sum("cacheWriteInputTokens"),
  });
});
