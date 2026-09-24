import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  asyncTool,
  cancelOperationTool,
  GuardrailError,
  humanApprovalTool,
  sleepTool,
  tool,
  ToolError,
  type ModelResponse,
} from "@restate-agents/core";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";
const ctx = () => testContext();
const done: ModelResponse = {type: "final", text: "done"};
const call = (name: string, id = name, input = {}) => ({id, name, input});
const batch = (...calls: ReturnType<typeof call>[]): ModelResponse => ({type: "tool_calls", calls});
const base = {description: "test", input: z.object({})};

void test("background completion gets one acknowledgment and a later model message", async () => {
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

void test("background results reach the next model request in completion order", async () => {
  await r.execute(
    ctx(),
    (function* () {
      const releaseA = r.channel<void>();
      const releaseB = r.channel<void>();
      let step = 0;
      const a = agent({
        tools: {
          a: tool({
            ...base,
            background: true,
            *execute() {
              yield* releaseA.receive;
              return "A";
            },
          }),
          b: tool({
            ...base,
            background: true,
            *execute() {
              yield* releaseB.receive;
              return "B";
            },
          }),
        },
        *model(request) {
          if (++step === 1) return batch(call("a"), call("b"));
          if (step === 2) {
            yield* releaseB.send();
            yield* releaseA.send();
            return {type: "final", text: "stale"};
          }
          const completed = request.messages.flatMap((message) => {
            if (message.role !== "user" || !message.content.includes("background-tool-result"))
              return [];
            return [JSON.parse(message.content).operationId as string];
          });
          assert.deepEqual(completed, ["b", "a"]);
          return done;
        },
      });
      const result = yield* a.run("go");
      assert.equal(result.output, "done");
      assert.equal(step, 3);
    })(),
  );
});

void test("steering during inference discards a stale final answer and retains the update", async () => {
  let step = 0;
  let discarded = false;
  await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        *model(req) {
          if (++step === 1) {
            try {
              yield* change.send("Use the new address");
              yield* r.channel().receive;
              return {type: "final", text: "old"};
            } finally {
              discarded = true;
            }
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
  assert.equal(discarded, true);
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

void test("interruption cancels inference and prevents its proposed tools", async () => {
  let modelCancelled = false;
  let toolRan = false;
  let steps = 0;
  await r.execute(
    ctx(),
    (function* () {
      const stop = r.channel<string>();
      const a = agent({
        finalize: false,
        *model() {
          steps++;
          try {
            yield* stop.send("stop now");
            yield* r.channel().receive;
            return batch(call("write"));
          } finally {
            modelCancelled = true;
          }
        },
        tools: {
          write: tool({
            ...base,
            *execute() {
              toolRan = true;
              return "written";
            },
          }),
        },
      });
      const result = yield* a.run("go", {controls: {interrupt: stop.receive}});
      assert.equal(result.status, "interrupted");
      if (result.status === "interrupted") assert.equal(result.reason, "stop now");
    })(),
  );
  assert.equal(modelCancelled, true);
  assert.equal(toolRan, false);
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

void test("selective background cancellation produces a model message and keeps unrelated work", async () => {
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
      if (step === 2) return batch(call("cancel", "cancel", {operationId: "wait", reason: null}));
      assert.match(JSON.stringify(req.messages), /cancelled/);
      return done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.equal(cleaned, true);
  history(result.messages);
});

void test(
  "steering reaches the model while a background tool is still pending",
  {timeout: 5000},
  async () => {
    let cleaned = false;
    let step = 0;
    await r.execute(
      ctx(),
      (function* () {
        const change = r.channel<string>();
        const never = r.channel<string>();
        let receives = 0;
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
          *model(request) {
            if (++step === 1) return batch(call("wait"));
            if (step === 2) {
              yield* change.send("Do not wait; cancel the sleep");
              return {type: "final", text: "stale"};
            }
            if (step === 3) {
              assert.match(JSON.stringify(request.messages), /cancel the sleep/);
              return batch(call("cancel", "cancel", {operationId: "wait", reason: null}));
            }
            assert.match(JSON.stringify(request.messages), /background-tool-result/);
            return done;
          },
        });
        const result = yield* a.run("go", {
          controls: {steering: () => (receives++ === 0 ? change.receive : never.receive)},
        });
        assert.equal(result.status, "completed");
        assert.ok(
          !result.messages.some(
            (message) => message.role === "assistant" && message.content === "stale",
          ),
        );
      })(),
    );
    assert.equal(cleaned, true);
    assert.equal(step, 4);
  },
);

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
    *onApproval(request, context) {
      order.push("publish-agent");
      assert.equal(context.secret, "private");
      assert.equal(request.invocationId, "test");
      // Each observer gets its own snapshot; changing one must not change routing or input.
      request.signalName = "changed";
      request.call.input = null;
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
  await r.execute(
    ctx(),
    a.run("go", {
      context: {secret: "private"},
      *onApproval(request, context) {
        order.push("publish-run");
        assert.equal(context.secret, "private");
        assert.match(request.signalName, /nested-0/);
        assert.deepEqual(request.call.input, {n: 2});
      },
    }),
  );
  assert.deepEqual(order, [
    "before",
    "publish-agent",
    "publish-run",
    "approval",
    "execute",
    "after",
  ]);
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
        *afterRun() {
          if (step === 1) yield* change.send("updated");
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

void test("startup finishes before the run subscribes to steering", async () => {
  let subscribed = false;
  const result = await r.execute(
    ctx(),
    agent({
      *beforeRun() {
        assert.equal(subscribed, false);
      },
      *model() {
        assert.equal(subscribed, true);
        return done;
      },
    }).run("go", {
      controls: {
        steering: () => {
          subscribed = true;
          return r.channel<string>().receive;
        },
      },
    }),
  );
  assert.equal(result.status, "completed");
});

for (const failure of [new Error("source failed"), null, undefined]) {
  void test(`control source failure propagates unchanged: ${String(failure)}`, async () => {
    let modelCleaned = false;
    let rejected = false;
    try {
      await r.execute(
        ctx(),
        (function* () {
          const change = r.channel<string>();
          const never = r.channel<string>();
          const brokenSource = r.spawn(
            (function* (): r.Operation<string> {
              throw failure;
            })(),
          );
          let receives = 0;
          const a = agent({
            *model() {
              try {
                yield* change.send("update");
                yield* never.receive;
                return done;
              } finally {
                modelCleaned = true;
              }
            },
          });
          yield* a.run("go", {
            controls: {
              steering: () => {
                if (receives++ === 0) return change.receive;
                return brokenSource;
              },
            },
          });
        })(),
      );
    } catch (error) {
      rejected = true;
      assert.equal(error, failure);
    }
    assert.equal(rejected, true);
    assert.equal(modelCleaned, true);
  });
}

void test("humanApprovalTool puts the model's question on the approval request", async () => {
  let step = 0;
  const questions: (string | undefined)[] = [];
  const a = agent({
    tools: {ask: humanApprovalTool()},
    *onHumanApproval(request) {
      questions.push(request.question);
      return false;
    },
    *model() {
      if (++step === 1) return batch(call("ask", "ask", {question: "Refund $40?"}));
      return done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.match(JSON.stringify(result.messages), /background-tool-result.*denied/);
  assert.deepEqual(questions, ["Refund $40?"]);
});

void test("approval details reach the approval handlers", async () => {
  let step = 0;
  const seen: unknown[] = [];
  const a = agent({
    tools: {
      refund: tool({
        description: "Refund an order.",
        input: z.object({cents: z.number()}),
        *execute(input, context) {
          const approved = yield* context.approve(input, {
            question: "Refund?",
            details: {policy: "large-refunds"},
          });
          return {approved};
        },
      }),
    },
    *onApproval(request) {
      seen.push(request.details);
    },
    *onHumanApproval(request) {
      seen.push(request.details);
      return true;
    },
    *model() {
      if (++step === 1) return batch(call("refund", "refund", {cents: 4000}));
      return done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [{policy: "large-refunds"}, {policy: "large-refunds"}]);
});

void test("a spent tool-call budget stops the run with a summary instead of failing it", async () => {
  let step = 0;
  let executed = 0;
  const a = agent({
    maxToolCalls: 2,
    finalize: function* () {
      return {type: "final", text: "Stopped early."};
    },
    tools: {
      work: tool({
        ...base,
        *execute() {
          executed++;
          return "ok";
        },
      }),
    },
    *model() {
      step++;
      if (step === 1) return batch(call("work", "a"), call("work", "b"));
      return batch(call("work", "c"));
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "stopped");
  assert.equal(result.status === "stopped" && result.reason, "max_tool_calls");
  assert.equal(result.output, "Stopped early.");
  assert.equal(executed, 2);
  // The rejected batch never entered history, so it stays protocol-complete.
  assert.equal(JSON.stringify(result.messages).includes('"c"'), false);
});

void test("a failing policy blocks the call and is reported as a guardrail failure", async () => {
  let step = 0;
  let executed = false;
  const a = agent({
    tools: {
      work: tool({
        ...base,
        *execute() {
          executed = true;
          return "ok";
        },
      }),
    },
    *beforeTool() {
      throw new TerminalError("policy model unavailable");
    },
    *model(req) {
      if (++step === 1) return batch(call("work"));
      const result = req.messages.find((m) => m.role === "tool");
      assert.deepEqual(result?.role === "tool" && result.result, {
        status: "error",
        code: "guardrail_failed",
        message: "Policy check failed: policy model unavailable",
      });
      return done;
    },
  });
  assert.equal((await r.execute(ctx(), a.run("go"))).status, "completed");
  assert.equal(executed, false);
});

void test("steering data returns on the steering progress event", async () => {
  const events: unknown[] = [];
  const result = await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<{message: string; data: {id: number}}>();
      const never = r.channel<string>();
      let listens = 0;
      let step = 0;
      const a = agent({
        tools: {
          wait: tool({
            ...base,
            *execute() {
              yield* change.send({message: "use the other file", data: {id: 7}});
              return "waited";
            },
          }),
        },
        *model(req) {
          if (++step === 1) return batch(call("wait"));
          assert.match(JSON.stringify(req.messages), /use the other file/);
          return done;
        },
      });
      return yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
        *onProgress(event) {
          if (event.type === "steering") events.push(event);
        },
      });
    })(),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(events, [{type: "steering", message: "use the other file", data: {id: 7}}]);
});

void test("built-in tools accept a description and display override", async () => {
  const events: unknown[] = [];
  let step = 0;
  const ask = humanApprovalTool({
    description: "Ask the account owner.",
    describe: ({question}) => ({name: `Asked: ${question}`}),
  });
  assert.equal(ask.description, "Ask the account owner.");
  assert.equal(sleepTool({description: "Pause."}).description, "Pause.");
  const a = agent({
    tools: {ask},
    *onHumanApproval() {
      return true;
    },
    *model() {
      if (++step === 1) return batch(call("ask", "a", {question: "Refund?"}));
      return done;
    },
  });
  await r.execute(
    ctx(),
    a.run("go", {
      *onProgress(event) {
        if (event.type === "tool-end") events.push(event.info);
      },
    }),
  );
  assert.deepEqual(events, [{name: "Asked: Refund?"}]);
});

void test("an instructions function is called as a method", async () => {
  const definition = {
    tone: "brief",
    *instructions(this: {tone: string}) {
      return `Be ${this.tone}.`;
    },
    *model(req: {instructions?: string}): Generator<never, ModelResponse> {
      assert.equal(req.instructions, "Be brief.");
      return done;
    },
  };
  assert.equal((await r.execute(ctx(), agent(definition).run("go"))).status, "completed");
});
