import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import MiniSearch from "minisearch";
import {z} from "zod";
import {
  agent,
  type AgentOptions,
  cancelOperationTool,
  handoff,
  type ModelResponse,
  type RunOptions,
  searchToolsTool,
  tool,
  ToolError,
  type ToolResult,
} from "@restatedev/agentlib";
import {programTool} from "@restatedev/agentlib/program";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";
const done: ModelResponse = {type: "final", text: "done"};
const context = () => testContext("ptc");

void test("tool search loads permitted schemas, resets between runs, and journals ranking", async (t) => {
  const a = agent({
    tools: {
      find: searchToolsTool(),
      github_notifications: tool({
        description: "Read unread notifications",
        provider: "github",
        deferred: true,
        input: z.object({}),
        *execute() {
          return [];
        },
      }),
    },
    *model(req) {
      if (!req.messages.some((m) => m.role === "tool")) {
        assert.deepEqual(
          req.tools.map((t) => t.name),
          ["find", "run_program", "read_tool_result"],
        );
        return {
          type: "tool_calls",
          calls: [{id: "search", name: "find", input: {query: "github unread notifications"}}],
        };
      }
      assert.deepEqual(
        req.tools.map((t) => t.name),
        ["find", "github_notifications", "run_program", "read_tool_result"],
      );
      return done;
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("find it"));
  const first = await runHandler(handler);
  assert.equal(first.output.status, "completed");
  await runHandler(handler); // An independent run starts with the deferred catalog again.
  t.mock.method(MiniSearch.prototype, "search", () => {
    throw Error("replay must not rank");
  });
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
});

void test("deferred tools stay visible when toolSearch is false", async () => {
  await r.execute(
    context(),
    agent({
      toolSearch: false,
      tools: {
        lookup: tool({
          description: "find",
          deferred: true,
          input: z.object({}),
          *execute() {
            return 1;
          },
        }),
      },
      *model(req) {
        assert.equal(req.tools[0]?.name, "lookup");
        return done;
      },
    }).run("go"),
  );
});

void test("a run searches deferred tools and runs programs by default", async () => {
  let step = 0;
  const a = agent({
    tools: {
      weather: tool({
        description: "Current weather in a city",
        deferred: true,
        input: z.object({city: z.string()}),
        *execute({city}) {
          return `${city}: sunny`;
        },
      }),
      cities: tool({
        description: "List the cities to report on",
        input: z.object({}),
        *execute() {
          return ["Ghent", "Berlin"];
        },
      }),
    },
    *model(req) {
      const names = req.tools.map((t) => t.name);
      if (++step === 1) {
        // The deferred tool stays hidden until a search loads it.
        assert.deepEqual(names, ["cities", "search_tools", "run_program", "read_tool_result"]);
        return {
          type: "tool_calls",
          calls: [{id: "s", name: "search_tools", input: {query: "weather"}}],
        };
      }
      if (step === 2) {
        assert.deepEqual(names, [
          "weather",
          "cities",
          "search_tools",
          "run_program",
          "read_tool_result",
        ]);
        const source =
          "const cities = await tools.cities({}); return await Promise.all(cities.map((city) => tools.weather({city})));";
        return {type: "tool_calls", calls: [{id: "p", name: "run_program", input: {source}}]};
      }
      const program = req.messages.find((m) => m.role === "tool" && m.callId === "p");
      assert.deepEqual(program?.role === "tool" && program.result, {
        status: "success",
        output: ["Ghent: sunny", "Berlin: sunny"],
      });
      return done;
    },
  });
  // Search journals its ranking, so this run needs a journal.
  const handler = (ctx: Context) => r.execute(ctx, a.run("go"));
  const first = await runHandler(handler);
  assert.equal(first.output.status, "completed");
  step = 0;
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
});

void test("an agent turns the default tools off or replaces them with its own", async () => {
  const lookup = tool({
    description: "find",
    deferred: true,
    input: z.object({}),
    *execute() {
      return 1;
    },
  });
  const listed = async (
    options: Omit<AgentOptions<undefined>, "model">,
    tools?: RunOptions<undefined>["tools"],
  ) => {
    let names: string[] = [];
    const a = agent({
      ...options,
      *model(req) {
        names = req.tools.map((t) => t.name);
        return done;
      },
    });
    await r.execute(context(), a.run("go", {tools}));
    return names;
  };
  assert.deepEqual(await listed({tools: {lookup}, toolSearch: false, programs: false}), [
    "lookup",
    "read_tool_result",
  ]);
  assert.deepEqual(
    await listed({tools: {find: searchToolsTool(), program: programTool(), lookup}}),
    ["find", "program", "read_tool_result"],
  );
  // Deferred tools passed to the run, such as MCP tools, are searched too.
  assert.deepEqual(await listed({}, {lookup}), ["search_tools", "run_program", "read_tool_result"]);
  // Without tools, or with only a handoff, a program has nothing to call.
  assert.deepEqual(await listed({}), []);
  const specialist = agent({
    *model() {
      return done;
    },
  });
  assert.deepEqual(await listed({tools: {transfer: handoff(specialist)}}), [
    "transfer",
    "read_tool_result",
  ]);
});

void test("a tool that takes a default tool's name fails the run", async () => {
  const a = agent({
    tools: {
      run_program: tool({
        description: "Run a TV program",
        input: z.object({}),
        *execute() {
          return null;
        },
      }),
    },
    *model() {
      return done;
    },
  });
  await assert.rejects(r.execute(context(), a.run("go")), /Duplicate tool name: run_program/);
});

void test("PTC shares approval and output policies while keeping intermediate results out of model context", async () => {
  let calls = 0,
    step = 0,
    approvals = 0;
  const a = agent({
    tools: {
      program: programTool(),
      read: tool({
        description: "read",
        deferred: true,
        input: z.object({n: z.number()}),
        needsApproval: true,
        *execute({n}) {
          calls++;
          return {n, private: "secret"};
        },
        *after(result) {
          return (result as {n: number}).n;
        },
      }),
    },
    *onHumanApproval() {
      approvals++;
      return true;
    },
    *model(req) {
      if (++step === 1)
        return {
          type: "tool_calls",
          calls: [
            {
              id: "p",
              name: "program",
              input: {
                source:
                  "return (await Promise.all([tools.read({n:2}),tools.read({n:4})])).reduce((a,b)=>a+b,0);",
              },
            },
          ],
        };
      assert.ok(!JSON.stringify(req.messages).includes("secret"));
      const outcome = req.messages.find((m) => m.role === "tool");
      assert.ok(outcome?.role === "tool");
      assert.deepEqual(outcome.result, {status: "success", output: 6});
      return done;
    },
  });
  await r.execute(context(), a.run("go"));
  assert.equal(calls, 2);
  assert.equal(approvals, 2);
});

void test("a failed program tells the model which tool calls already ran", async () => {
  let failure: ToolResult | undefined;
  const a = agent({
    tools: {
      program: programTool(),
      write: tool({
        description: "write",
        input: z.object({}),
        *execute() {
          return "written";
        },
      }),
      check: tool({
        description: "check",
        input: z.object({}),
        *execute() {
          throw new ToolError("not ready");
        },
      }),
      wait: tool({
        description: "wait",
        input: z.object({}),
        *execute() {
          yield* r.channel().receive;
          return null;
        },
      }),
    },
    *model(req) {
      const result = req.messages.find((m) => m.role === "tool");
      if (result?.role === "tool") {
        failure = result.result;
        return done;
      }
      const source = [
        "tools.wait({});",
        "await tools.write({}); await tools.write({});",
        "try { await tools.check({}); } catch {}",
        "throw new Error('gave up');",
      ].join("\n");
      return {type: "tool_calls", calls: [{id: "p", name: "program", input: {source}}]};
    },
  });
  await r.execute(context(), a.run("go"));
  assert.deepEqual(failure, {
    status: "error",
    code: "program_error",
    message: [
      "Error: gave up",
      "    at <anonymous> (program.js:4:16)",
      "",
      "Tool calls made before the failure, which are not undone: wait (1 cancelled), write (2 ok), check (1 error).",
    ].join("\n"),
  });
});

void test("a program that fails before calling a tool says so", async () => {
  let message: string | undefined;
  const a = agent({
    tools: {program: programTool()},
    *model(req) {
      const result = req.messages.find((m) => m.role === "tool");
      if (result?.role === "tool") {
        if (result.result.status === "error") message = result.result.message;
        return done;
      }
      return {
        type: "tool_calls",
        calls: [{id: "p", name: "program", input: {source: "return 1 +;"}}],
      };
    },
  });
  await r.execute(context(), a.run("go"));
  assert.match(message ?? "", /SyntaxError[^]*\n\nNo tool calls were made\.$/);
});

void test("PTC failure and child cleanup remain native through the full agent dispatcher", async () => {
  let cleaned = false,
    step = 0;
  const a = agent({
    tools: {
      program: programTool(),
      wait: tool({
        description: "wait",
        input: z.object({}),
        *execute() {
          try {
            yield* r.channel().receive;
            return 0;
          } finally {
            cleaned = true;
          }
        },
      }),
      fast: tool({
        description: "fast",
        input: z.object({}),
        *execute() {
          return 9;
        },
      }),
    },
    *model(req) {
      if (++step === 1)
        return {
          type: "tool_calls",
          calls: [
            {
              id: "p",
              name: "program",
              input: {source: "return await Promise.race([tools.wait({}),tools.fast({})]);"},
            },
          ],
        };
      assert.match(JSON.stringify(req.messages), /"output":9/);
      return done;
    },
  });
  await r.execute(context(), a.run("go"));
  assert.equal(cleaned, true);
});

void test("PTC runs and nested durable effects replay without invoking the host again", async () => {
  let effects = 0;
  const a = agent({
    tools: {
      program: programTool(),
      read: tool({
        description: "read",
        input: z.object({n: z.number()}),
        *execute({n}) {
          return yield* r.run(
            async () => {
              effects++;
              return n * 2;
            },
            {name: "read"},
          );
        },
      }),
    },
    *model(req) {
      if (req.messages.some((m) => m.role === "tool")) return done;
      return {
        type: "tool_calls",
        calls: [
          {
            id: "p",
            name: "program",
            input: {
              source: "return await Promise.all([tools.read({n:2}),tools.read({n:4})]);",
            },
          },
        ],
      };
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("go"));
  const first = await runHandler(handler);
  assert.equal(effects, 2);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(effects, 2);
});

void test("steering hands a still-running program to the background instead of waiting for it", async () => {
  let cleaned = false,
    step = 0;
  await r.execute(
    context(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        tools: {
          program: programTool({tools: ["wait"]}),
          // Blocks until cancelled, like a long sleep inside a program.
          wait: tool({
            description: "wait",
            input: z.object({}),
            *execute() {
              try {
                yield* change.send("Don't wait, actually");
                yield* r.channel().receive;
                return 0;
              } finally {
                cleaned = true;
              }
            },
          }),
          lookup: tool({
            description: "lookup",
            input: z.object({}),
            *execute() {
              return "sunny";
            },
          }),
          cancel: cancelOperationTool(),
        },
        *model(req): Generator<never, ModelResponse> {
          if (++step === 1)
            return {
              type: "tool_calls",
              calls: [
                {id: "p", name: "program", input: {source: "return await tools.wait({});"}},
                {id: "l", name: "lookup", input: {}},
              ],
            };
          const results = new Map<string, ToolResult>();
          for (const m of req.messages) if (m.role === "tool") results.set(m.callId, m.result);
          if (step === 2) {
            // The steer arrives while the program still runs; its handle is pending.
            assert.match(JSON.stringify(req.messages), /Don't wait, actually/);
            assert.deepEqual(results.get("p"), {status: "pending", operationId: "p"});
            assert.deepEqual(results.get("l"), {status: "success", output: "sunny"});
            return {
              type: "tool_calls",
              calls: [{id: "c", name: "cancel", input: {operationId: "p", reason: null}}],
            };
          }
          assert.deepEqual(results.get("c"), {status: "success", output: {cancelled: true}});
          assert.match(JSON.stringify(req.messages), /background-tool-result/);
          return done;
        },
      });
      const result = yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
      });
      assert.equal(result.status, "completed");
    })(),
  );
  assert.equal(cleaned, true);
  assert.equal(step, 3);
});

void test("invalid program limits fail when the tool is defined", () => {
  assert.throws(() => programTool({limits: {maxToolCalls: 0}}), /maxToolCalls/);
});
