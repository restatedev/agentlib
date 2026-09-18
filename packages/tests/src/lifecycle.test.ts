import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  asyncTool,
  cancelOperationTool,
  GuardrailError,
  tool,
  ToolError,
  type AgentUpdate,
  type ModelResponse,
} from "@restate-agents/core";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
const ctx = () =>
  ({
    request: () => ({id: "test", attemptCompletedSignal: new AbortController().signal}),
  }) as unknown as Context;
const done: ModelResponse = {type: "final", text: "done"};
const call = (name: string, id = name, input = {}) => ({id, name, input});
const batch = (...calls: ReturnType<typeof call>[]): ModelResponse => ({type: "tool_calls", calls});
const base = {description: "test", input: z.object({})};

void test("background completion gets one acknowledgment and a later runtime observation", async () => {
  let step = 0;
  const result = await r.execute(
    ctx(),
    (function* () {
      const release = r.channel<void>();
      const a = agent({
        tools: {
          wait: tool({
            ...base,
            background: true,
            *execute() {
              yield* release.receive;
              return 42;
            },
          }),
        },
        *model(req) {
          if (++step === 1) return batch(call("wait"));
          if (step === 2) {
            assert.equal(req.messages.at(-1)?.role, "tool");
            yield* release.send();
            return {type: "final", text: "stale"};
          }
          assert.match(JSON.stringify(req.messages), /background-tool-result/);
          return done;
        },
      });
      return yield* a.run("go");
    })(),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 1);
  assert.equal(
    result.messages.some((m) => m.role === "assistant" && m.content === "stale"),
    false,
  );
  history(result.messages);
});

void test("steering during inference discards a stale final answer and retains the update", async () => {
  let step = 0;
  await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        *model(req) {
          if (++step === 1) {
            yield* change.send("Use the new address");
            return {type: "final", text: "old"};
          }
          assert.match(JSON.stringify(req.messages), /new address/);
          return done;
        },
      });
      const result = yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
      });
      assert.equal(result.status, "completed");
      assert.equal(
        result.messages.some((m) => m.role === "assistant" && m.content === "old"),
        false,
      );
    })(),
  );
  assert.equal(step, 2);
});

void test("steering preserves effects from the active tool batch", async () => {
  await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0,
        step = 0;
      const a = agent({
        tools: {
          write: tool({
            ...base,
            *execute() {
              yield* change.send("Now read it");
              return "written";
            },
          }),
        },
        *model(req) {
          if (++step === 1) return batch(call("write"));
          history(req.messages);
          assert.match(JSON.stringify(req.messages), /written.*Now read it/);
          return done;
        },
      });
      const result = yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
      });
      history(result.messages);
    })(),
  );
});

void test("interruption aborts inference, cleans its task, and makes no later tool calls", async () => {
  let cleaned = false,
    steps = 0;
  await r.execute(
    ctx(),
    (function* () {
      const stop = r.channel<string>();
      const a = agent({
        *model() {
          steps++;
          try {
            yield* stop.send("stop now");
            yield* r.channel().receive;
            return done;
          } finally {
            cleaned = true;
          }
        },
      });
      const result = yield* a.run("go", {controls: {interrupt: stop.receive}});
      assert.equal(result.status, "interrupted");
      if (result.status === "interrupted") assert.equal(result.reason, "stop now");
    })(),
  );
  assert.equal(cleaned, true);
  assert.equal(steps, 1);
});

void test("interruption preserves completed results, closes unfinished calls, and finalizes without tools", async () => {
  await r.execute(
    ctx(),
    (function* () {
      const stop = r.channel<string>(),
        written = r.channel<void>();
      const a = agent({
        *model() {
          return batch(call("write"), call("wait"));
        },
        tools: {
          write: tool({
            ...base,
            *execute() {
              yield* written.send();
              return "saved";
            },
          }),
          wait: tool({
            ...base,
            *execute() {
              yield* written.receive;
              yield* stop.send("user stopped");
              yield* r.channel().receive;
              return 0;
            },
          }),
        },
        *finalize(req) {
          assert.deepEqual(req.tools, []);
          assert.match(JSON.stringify(req.messages), /saved/);
          return {type: "final", text: "Stopped after saving"};
        },
      });
      const result = yield* a.run("go", {controls: {interrupt: stop.receive}});
      assert.equal(result.status, "interrupted");
      assert.equal(result.output, "Stopped after saving");
      const results = result.messages.flatMap((m) => (m.role === "tool" ? [m.result.status] : []));
      assert.deepEqual(results, ["success", "cancelled"]);
      history(result.messages);
    })(),
  );
});

void test("a background failure interrupts a later parked model and joins every tool", async () => {
  const failure = new Error("background failed");
  let cleaned = false;
  await assert.rejects(
    r.execute(
      ctx(),
      (function* () {
        const go = r.channel<void>();
        let step = 0;
        const a = agent({
          tools: {
            wait: tool({
              ...base,
              background: true,
              *execute() {
                yield* go.receive;
                throw failure;
              },
            }),
          },
          *model() {
            if (++step === 1) return batch(call("wait"));
            try {
              yield* go.send();
              yield* r.channel().receive;
              return done;
            } finally {
              cleaned = true;
            }
          },
        });
        return yield* a.run("go");
      })(),
    ),
    (e) => e === failure,
  );
  assert.equal(cleaned, true);
});

void test("selective background cancellation produces an observation and keeps unrelated work", async () => {
  let cleaned = false,
    step = 0;
  const a = agent({
    tools: {
      wait: tool({
        ...base,
        background: true,
        *execute() {
          try {
            yield* r.channel().receive;
            return 0;
          } finally {
            cleaned = true;
          }
        },
      }),
      cancel: cancelOperationTool(),
    },
    *model(req) {
      if (++step === 1) return batch(call("wait"));
      if (step === 2) return batch(call("cancel", "cancel", {operationId: "wait"}));
      assert.match(JSON.stringify(req.messages), /cancelled/);
      return done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.equal(cleaned, true);
  history(result.messages);
});

void test("nested calls share tool policies, private context, approval, and output filtering", async () => {
  const order: string[] = [];
  let step = 0;
  const a = agent<{secret: string}>({
    tools: {
      parent: tool({
        ...base,
        *execute(_, context) {
          return yield* context.callTool("child", {n: 2});
        },
      }),
      child: tool({
        description: "child",
        input: z.object({n: z.number()}),
        *before() {
          order.push("before");
          return true;
        },
        needsApproval: true,
        *execute({n}, context) {
          order.push("execute");
          assert.equal(context.context.secret, "private");
          return {n, secret: "sensitive"};
        },
        *after(value) {
          order.push("after");
          return {n: (value as {n: number}).n};
        },
      }),
    },
    *onHumanApproval(request) {
      order.push("approval");
      assert.match(request.signalName, /nested-0/);
      return true;
    },
    *model(req) {
      assert.ok(!JSON.stringify(req).includes("private"));
      if (++step === 1) return batch(call("parent"));
      assert.ok(!JSON.stringify(req).includes("sensitive"));
      return done;
    },
  });
  await r.execute(ctx(), a.run("go", {context: {secret: "private"}}));
  assert.deepEqual(order, ["before", "approval", "execute", "after"]);
});

void test("run and tool denials precede effects, and approval denial is recoverable", async () => {
  let touched = false,
    step = 0;
  const a = agent({
    *model() {
      return ++step === 1 ? batch(call("write")) : done;
    },
    tools: {
      write: tool({
        ...base,
        needsApproval: true,
        *execute() {
          touched = true;
          return 0;
        },
      }),
    },
    *onHumanApproval() {
      return false;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(touched, false);
  assert.equal(
    result.messages.some((m) => m.role === "tool" && m.result.status === "denied"),
    true,
  );
  await assert.rejects(
    r.execute(
      ctx(),
      agent({
        *model() {
          touched = true;
          return done;
        },
        *beforeRun() {
          return false;
        },
      }).run("go"),
    ),
    GuardrailError,
  );
  assert.equal(touched, false);
});

void test("async business errors and background results survive full journal replay", async () => {
  let effects = 0;
  const a = agent({
    tools: {
      expected: asyncTool({
        ...base,
        background: true,
        async execute() {
          effects++;
          throw new ToolError("not available", "unavailable");
        },
      }),
    },
    *model(req) {
      return yield* r.run(
        async () => (req.messages.some((m) => m.role === "tool") ? done : batch(call("expected"))),
        {name: "model"},
      );
    },
  });
  const handler = (context: Context) => r.execute(context, a.run("go"));
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.equal(effects, 1);
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(effects, 1);
});

void test("stream consumption returns ordered updates and closing it joins active work", async () => {
  let cleaned = false;
  await r.execute(
    ctx(),
    (function* () {
      const started = r.channel<void>();
      const a = agent({
        *model() {
          return batch(call("wait"));
        },
        tools: {
          wait: tool({
            ...base,
            *execute() {
              try {
                yield* started.send();
                yield* r.channel().receive;
                return 0;
              } finally {
                cleaned = true;
              }
            },
          }),
        },
      });
      const stream = yield* a.stream("go");
      const first = yield* stream.next();
      assert.equal(first.done, false);
      yield* started.receive;
      yield* stream.close();
    })(),
  );
  assert.equal(cleaned, true);
  const updates: AgentUpdate[] = [];
  await r.execute(
    ctx(),
    (function* () {
      const stream = yield* agent({
        *model() {
          return done;
        },
      }).stream("go");
      while (true) {
        const next = yield* stream.next();
        if (next.done) break;
        updates.push(next.value);
      }
      assert.equal((yield* stream.result).status, "completed");
    })(),
  );
  assert.deepEqual(
    updates.map((u) => u.sequence),
    [1, 2],
  );
  assert.equal(new Set(updates.map((u) => u.id)).size, 2);
});

void test("steering received during an output guard triggers a fresh answer", async () => {
  let step = 0;
  await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        *model(req) {
          if (++step === 1) return {type: "final", text: "old"};
          assert.match(JSON.stringify(req.messages), /updated/);
          return done;
        },
        *afterRun(result) {
          if (step === 1) yield* change.send("updated");
          return result;
        },
      });
      const result = yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
      });
      assert.equal(result.output, "done");
      assert.equal(
        result.messages.some((m) => m.role === "assistant" && m.content === "old"),
        false,
      );
    })(),
  );
  assert.equal(step, 2);
});
