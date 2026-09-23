import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import {CancelledError} from "@restatedev/restate-sdk";
import {
  all,
  allSettled,
  channel,
  execute,
  gen,
  InterruptedError,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  tool,
  ToolError,
  ModelProtocolError,
  RunInputError,
  type Message,
  type Model,
  type ModelResponse,
  type ToolContext,
} from "@restate-agents/core";

// Real coroutine scheduler; these tests need no transport or live Restate server.
function context(): Context {
  return {
    request: () => ({id: "test-run", attemptCompletedSignal: new AbortController().signal}),
  } as unknown as Context;
}

const call = (id: string, name: string, input = {}): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name, input}],
});
const final: ModelResponse = {type: "final", text: "Done"};
function scripted(...responses: ModelResponse[]): Model {
  let index = 0;
  return function* () {
    assert.ok(index < responses.length, "Unexpected additional model call");
    return responses[index++]!;
  };
}

void test("an agent is a composable operation and needs no service or global client", async () => {
  const a = agent({model: scripted(final)});
  const result = await execute(context(), a.run("Hello"));
  assert.equal(result.status, "completed");
  assert.equal(result.steps, 1);
  assert.deepEqual(result.messages, [
    {role: "user", content: "Hello"},
    {role: "assistant", content: "Done"},
  ]);
});

void test("tools infer validated inputs and receive private per-run context", async () => {
  type Data = {tenant: string};
  const seen: unknown[] = [];
  const a = agent<Data>({
    instructions: "Use the lookup tool",
    tools: {
      lookup: tool({
        description: "Look up a record",
        input: z.object({count: z.number().default(2)}),
        *execute(input, ctx: ToolContext<Data>) {
          seen.push([input.count, ctx.context.tenant, ctx.callId, ctx.step]);
          return {count: input.count};
        },
      }),
    },
    *model(request) {
      assert.equal(request.instructions, "Use the lookup tool");
      assert.ok(!JSON.stringify(request).includes("private-tenant"));
      assert.equal(request.tools[0]!.inputSchema.type, "object");
      return request.messages.length === 1 ? call("lookup-1", "lookup") : final;
    },
  });
  await execute(context(), a.run("Look it up", {context: {tenant: "private-tenant"}}));
  assert.deepEqual(seen, [[2, "private-tenant", "lookup-1", 1]]);
});

void test(
  "tool calls run concurrently and results enter history as they complete",
  {timeout: 5000},
  async () => {
    const result = await execute(
      context(),
      gen(function* () {
        const bothStarted = channel<void>();
        const releaseFirst = channel<void>();
        const completionOrder: string[] = [];
        const a = agent({
          model: scripted(
            {
              type: "tool_calls",
              calls: [
                {id: "a", name: "first", input: {}},
                {id: "b", name: "second", input: {}},
              ],
            },
            final,
          ),
          tools: {
            first: tool({
              description: "First",
              input: z.object({}),
              *execute() {
                yield* bothStarted.receive;
                yield* releaseFirst.receive;
                completionOrder.push("first");
                return 1;
              },
            }),
            second: tool({
              description: "Second",
              input: z.object({}),
              *execute() {
                yield* bothStarted.send();
                completionOrder.push("second");
                yield* releaseFirst.send();
                return 2;
              },
            }),
          },
        });
        const result = yield* a.run("Both");
        assert.deepEqual(completionOrder, ["second", "first"]);
        return result;
      }),
    );
    assert.deepEqual(
      result.messages.filter((m) => m.role === "tool").map((m) => m.callId),
      ["b", "a"],
    );
  },
);

void test("unknown tools, invalid arguments, and explicit tool errors become model-visible results", async () => {
  let executed = 0;
  const a = agent({
    tools: {
      lookup: tool({
        description: "Lookup",
        input: z.object({id: z.string()}),
        *execute() {
          executed++;
          throw new ToolError("No matching record", "not_found");
        },
      }),
    },
    model: scripted(
      {
        type: "tool_calls",
        calls: [
          {id: "a", name: "missing", input: {}},
          {id: "b", name: "lookup", input: {id: 3}},
          {id: "c", name: "lookup", input: {id: "valid"}},
        ],
      },
      final,
    ),
  });
  const result = await execute(context(), a.run("Find"));
  assert.equal(executed, 1);
  assert.deepEqual(
    result.messages.flatMap((m) =>
      m.role === "tool" && m.result.status === "error" ? [m.result.code] : [],
    ),
    ["unknown_tool", "invalid_input", "not_found"],
  );
});

void test(
  "unexpected tool failure joins siblings before control returns to the caller",
  {
    timeout: 5000,
  },
  async () => {
    let cleaned = false;
    const failure = new Error("infrastructure failure");
    await execute(
      context(),
      gen(function* () {
        const started = channel<void>();
        const never = channel<void>();
        const a = agent({
          model: scripted({
            type: "tool_calls",
            calls: [
              {id: "a", name: "wait", input: {}},
              {id: "b", name: "fail", input: {}},
            ],
          }),
          tools: {
            wait: tool({
              description: "Wait",
              input: z.object({}),
              *execute() {
                try {
                  yield* started.send();
                  yield* never.receive;
                  return null;
                } finally {
                  cleaned = true;
                }
              },
            }),
            fail: tool({
              description: "Fail",
              input: z.object({}),
              *execute() {
                yield* started.receive;
                throw failure;
              },
            }),
          },
        });
        try {
          yield* a.run("Go");
          assert.fail("Should fail");
        } catch (error) {
          assert.equal(error, failure);
          assert.equal(cleaned, true);
        }
      }),
    );
  },
);

void test("native interruption propagates and runs tool cleanup", {timeout: 5000}, async () => {
  let cleaned = false;
  await execute(
    context(),
    gen(function* () {
      const ready = channel<void>();
      const never = channel<void>();
      const a = agent({
        model: scripted(call("a", "wait")),
        tools: {
          wait: tool({
            description: "Wait",
            input: z.object({}),
            *execute() {
              try {
                yield* ready.send();
                yield* never.receive;
                return null;
              } finally {
                cleaned = true;
              }
            },
          }),
        },
      });
      const task = spawn(a.run("Wait"));
      yield* ready.receive;
      const reason = new InterruptedError("Stop");
      task.interrupt(reason);
      const [settled] = yield* allSettled([task]);
      assert.equal(settled.status, "rejected");
      if (settled.status === "rejected") assert.equal(settled.reason, reason);
      assert.equal(cleaned, true);
    }),
  );
});

void test("invocation cancellation is not converted to a tool result", async () => {
  const cancelled = new CancelledError();
  const a = agent({
    model: scripted(call("a", "cancel")),
    tools: {
      cancel: tool({
        description: "Cancel",
        input: z.object({}),
        *execute() {
          throw cancelled;
        },
      }),
    },
  });
  await assert.rejects(execute(context(), a.run("Go")), (error) => error === cancelled);
});

void test("maxSteps stops a tool-only loop with a complete transcript", async () => {
  const a = agent({maxSteps: 2, model: scripted(call("a", "missing"), call("b", "missing"))});
  const result = await execute(context(), a.run("Loop"));
  assert.equal(result.status, "stopped");
  if (result.status === "stopped") assert.equal(result.reason, "max_steps");
  assert.equal(result.steps, 2);
  assert.equal(result.messages.at(-1)?.role, "tool");
  const continued = await execute(
    context(),
    agent({model: scripted(final)}).run("Summarize", {messages: result.messages}),
  );
  assert.equal(continued.status, "completed");
});

void test("duplicate tool-call IDs reject the entire batch before any tool starts", async () => {
  let executed = 0;
  const a = agent({
    model: scripted({
      type: "tool_calls",
      calls: [
        {id: "same", name: "write", input: {}},
        {id: "same", name: "write", input: {}},
      ],
    }),
    tools: {
      write: tool({
        description: "Write",
        input: z.object({}),
        *execute() {
          executed++;
          return null;
        },
      }),
    },
  });
  await assert.rejects(execute(context(), a.run("Go")), ModelProtocolError);
  assert.equal(executed, 0);
});

void test("empty model responses and tool batches fail instead of parking or looping", async () => {
  for (const response of [
    {type: "final", text: " "},
    {type: "tool_calls", calls: []},
  ]) {
    const a = agent({model: scripted(response as ModelResponse)});
    await assert.rejects(execute(context(), a.run("Go")), ModelProtocolError);
  }
});

void test("non-JSON tool output is reported to the model instead of retried", async () => {
  const a = agent({
    *model(request) {
      if (request.step === 1) return call("a", "bad");
      const last = request.messages.at(-1);
      assert.deepEqual(last?.role === "tool" && last.result, {
        status: "error",
        code: "invalid_output",
        message: "Tool output must be JSON",
      });
      return final;
    },
    tools: {
      bad: tool({
        description: "Bad",
        input: z.object({}),
        *execute() {
          return Number.NaN;
        },
      }),
    },
  });
  assert.equal((await execute(context(), a.run("Go"))).status, "completed");
});

void test("history is copied and incomplete protocol histories fail before inference", async () => {
  const prior: Message[] = [
    {role: "user", content: "Before"},
    {role: "assistant", content: "Previous answer"},
  ];
  const a = agent({
    *model(request) {
      request.messages.length = 0;
      return final;
    },
  });
  const result = await execute(context(), a.run("Next", {messages: prior}));
  assert.equal(prior.length, 2);
  assert.equal(result.messages.length, 4);
  let invoked = false;
  const bad = agent({
    *model() {
      invoked = true;
      return final;
    },
  });
  await assert.rejects(
    execute(
      context(),
      bad.run("Next", {
        messages: [{role: "assistant", content: "", calls: [{id: "a", name: "tool", input: {}}]}],
      }),
    ),
    (error) => error instanceof RunInputError && /unfinished/.test(error.message),
  );
  assert.equal(invoked, false);
});

void test("the same agent definition supports independent concurrent runs", async () => {
  const a = agent({
    *model(request) {
      return {
        type: "final",
        text: request.messages[0]!.role === "user" ? request.messages[0]!.content : "wrong",
      };
    },
  });
  const results = await execute(
    context(),
    gen(function* () {
      return yield* all([spawn(a.run("First")), spawn(a.run("Second"))]);
    }),
  );
  assert.deepEqual(
    results.map((r) => r.messages[0]),
    [
      {role: "user", content: "First"},
      {role: "user", content: "Second"},
    ],
  );
});

void test("invalid configuration and empty input fail early", async () => {
  for (const maxSteps of [0, -1, 1.5, Infinity])
    assert.throws(() => agent({model: scripted(final), maxSteps}), /maxSteps/);
  await assert.rejects(execute(context(), agent({model: scripted(final)}).run(" ")), /nonempty/);
});
