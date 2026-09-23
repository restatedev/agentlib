import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import MiniSearch from "minisearch";
import {z} from "zod";
import {
  agent,
  cancelOperationTool,
  searchToolsTool,
  tool,
  type ModelResponse,
  type ToolResult,
} from "@restate-agents/core";
import {programTool} from "@restate-agents/core/program";
import {runHandler} from "./replay-harness.mjs";
const done: ModelResponse = {type: "final", text: "done"};
const context = () =>
  ({
    request: () => ({id: "ptc", attemptCompletedSignal: new AbortController().signal}),
  }) as unknown as Context;

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
          ["find"],
        );
        return {
          type: "tool_calls",
          calls: [{id: "search", name: "find", input: {query: "github unread notifications"}}],
        };
      }
      assert.deepEqual(
        req.tools.map((t) => t.name),
        ["find", "github_notifications"],
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

void test("deferred tools stay visible when search is not installed", async () => {
  await r.execute(
    context(),
    agent({
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
                  "async tools => (await Promise.all([tools.read({n:2}),tools.read({n:4})])).reduce((a,b)=>a+b,0)",
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
              input: {source: "async tools => await Promise.race([tools.wait({}),tools.fast({})])"},
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
              source: "async tools => await Promise.all([tools.read({n:2}),tools.read({n:4})])",
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
                {id: "p", name: "program", input: {source: "async tools => await tools.wait({})"}},
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
              calls: [{id: "c", name: "cancel", input: {operationId: "p"}}],
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
