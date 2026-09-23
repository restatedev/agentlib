import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {TerminalError} from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  asyncTool,
  cancelOperationTool,
  handoff,
  handlerTool,
  serviceTool,
  LazyStateConversation,
  sleepTool,
  tool,
  type ModelResponse,
  type ToolCall,
  type Conversation,
} from "@restate-agents/core";
import {programTool} from "@restate-agents/core/program";
import {restateTools} from "@restate-agents/core/discovery";
import {modelGateway} from "@restate-agents/core/provider";
import {aiSession} from "@restate-agents/examples/gensdk/session";
const final: ModelResponse = {type: "final", text: "done"};
const base = {description: "fixture", input: z.object({})};
const effects = new Map<string, number>();
const child = r.object({
  name: "SdkChild",
  handlers: {
    *lookup() {
      yield* r.sleep(5);
      return {found: true};
    },
    *wait() {
      try {
        yield* r.sleep(60000);
        return {unexpected: true};
      } finally {
        r.state().set("cleaned", true);
      }
    },
  },
  options: {handlers: {lookup: {metadata: {"restate.dev/agent": "lookupDiscovered"}}}},
});
const gateway = r.service({
  name: "SdkGateway",
  handlers: {
    *generate(): r.Operation<ModelResponse> {
      yield* r.sleep(5);
      return final;
    },
  },
});
const runner = r.service({
  name: "SdkHarness",
  handlers: {
    *concurrentRuns() {
      const a = agent<{owner: string}>({
        maxToolCalls: 1,
        tools: {
          owner: tool({
            ...base,
            *execute(_, context) {
              yield* r.sleep(5);
              return context.context.owner;
            },
          }),
        },
        *model(request) {
          if (request.step === 1)
            return {type: "tool_calls", calls: [{id: "same-call-id", name: "owner", input: {}}]};
          const last = request.messages.at(-1);
          if (
            last?.role === "tool" &&
            last.result.status === "success" &&
            typeof last.result.output === "string"
          ) {
            return {type: "final", text: last.result.output};
          }
          return {type: "final", text: "missing tool result"};
        },
      });
      return yield* r.all(
        ["first", "second"].map((name) =>
          r.spawn(
            (function* () {
              return yield* a.run(name, {name, context: {owner: name}});
            })(),
          ),
        ),
      );
    },
    *steeringBursts() {
      const steering = r.invocation(r.handlerRequest().id).signal<string>("steering");
      let signalsSent = 0;
      const result = yield* agent({
        *model(request) {
          if (request.step === 1) {
            steering.resolve("first");
            signalsSent++;
            steering.resolve("second");
            signalsSent++;
            yield* r.sleep(5);
            return {type: "final", text: "stale"};
          }
          yield* r.sleep(25);
          return final;
        },
      }).run("go", {steeringSignal: "steering"});
      return {result, signalsSent};
    },
    *steeringBeforeModel() {
      let writes = 0;
      const result = yield* agent({
        tools: {
          write: tool({
            ...base,
            *execute() {
              writes++;
              return "written";
            },
          }),
        },
        *beforeStep(request) {
          if (request.step === 1) {
            r.invocation(r.handlerRequest().id).signal("steering").resolve("Do not write");
            yield* r.sleep(5);
          }
        },
        *model(request): r.Operation<ModelResponse> {
          if (request.step === 1)
            return {type: "tool_calls", calls: [{id: "write", name: "write", input: {}}]};
          assert.match(JSON.stringify(request.messages), /Do not write/);
          return final;
        },
      }).run("go", {steeringSignal: "steering"});
      return {result, writes};
    },
    *steeringDuringTool() {
      const self = r.invocation(r.handlerRequest().id);
      let step = 0;
      const result = yield* agent({
        tools: {
          write: tool({
            ...base,
            *execute() {
              self.signal("steering").resolve("First revision");
              self.signal("steering").resolve("Second revision");
              yield* r.sleep(5);
              return "written";
            },
          }),
        },
        *model(request): r.Operation<ModelResponse> {
          if (++step === 1)
            return {type: "tool_calls", calls: [{id: "write", name: "write", input: {}}]};
          if (!JSON.stringify(request.messages).includes("Second revision"))
            return {type: "final", text: "stale"};
          return final;
        },
      }).run("go", {steeringSignal: "steering"});
      return {result, step};
    },
    *steerPendingSleep() {
      const self = r.invocation(r.handlerRequest().id);
      const finalSubmitted = r.channel<void>();
      r.spawn(
        (function* () {
          yield* finalSubmitted.receive;
          yield* r.sleep(25);
          self.signal("steering").resolve("Do not sleep; cancel it");
        })(),
      );
      let step = 0;
      const result = yield* agent({
        tools: {sleep: sleepTool(), cancel: cancelOperationTool()},
        *model(request): r.Operation<ModelResponse> {
          if (++step === 1)
            return {
              type: "tool_calls",
              calls: [{id: "sleep", name: "sleep", input: {milliseconds: 60000}}],
            };
          if (step === 2) {
            assert.match(JSON.stringify(request.messages), /"status":"pending"/);
            yield* finalSubmitted.send();
            return {type: "final", text: "stale"};
          }
          if (step === 3) {
            assert.match(JSON.stringify(request.messages), /Do not sleep/);
            return {
              type: "tool_calls",
              calls: [{id: "cancel", name: "cancel", input: {operationId: "sleep"}}],
            };
          }
          assert.match(JSON.stringify(request.messages), /background-tool-result/);
          return final;
        },
      }).run("go", {steeringSignal: "steering"});
      return {result, step};
    },
    *toolLimits(limit: "calls" | "depth") {
      const executed: string[] = [];
      const write = asyncTool({
        ...base,
        async execute() {
          effects.set(`limit-${limit}`, (effects.get(`limit-${limit}`) ?? 0) + 1);
          return "written";
        },
      });
      const specialist = agent({
        tools: {write},
        *model() {
          return {type: "tool_calls", calls: [{id: "write", name: "write", input: {}}]};
        },
      });
      const a = agent({
        maxToolCalls: 3,
        maxToolDepth: 1,
        tools: {
          write,
          transfer: handoff(specialist),
          outer: tool({
            ...base,
            *execute(_, context) {
              executed.push("outer");
              return yield* context.callTool("nested", {});
            },
          }),
          nested: tool({
            ...base,
            *execute(_, context) {
              executed.push("nested");
              return limit === "depth" ? yield* context.callTool("write", {}) : "done";
            },
          }),
        },
        *model(request) {
          const name = request.step === 1 ? "outer" : "transfer";
          return {type: "tool_calls", calls: [{id: name, name, input: {}}]};
        },
      });
      try {
        yield* a.run("go");
        return {executed, error: "Expected a tool limit failure"};
      } catch (error) {
        return {executed, error: String(error)};
      }
    },
    *toolInfo() {
      const result = yield* agent({
        tools: {
          closeTicket: asyncTool({
            description: "Close a demo ticket",
            input: z.object({ticketId: z.string(), reason: z.string()}),
            describe: ({ticketId}) => ({name: "Close ticket", details: {ticketId}}),
            async execute(input) {
              effects.set("tool-info", (effects.get("tool-info") ?? 0) + 1);
              return {closed: input.ticketId, reason: input.reason};
            },
          }),
        },
        *model(request): r.Operation<ModelResponse> {
          if (request.step === 1) {
            return {
              type: "tool_calls",
              calls: [
                {id: "close", name: "closeTicket", input: {ticketId: "T-42", reason: "Resolved"}},
              ],
            };
          }
          return final;
        },
      }).run("Close T-42");
      return {result, invocationId: r.handlerRequest().id};
    },
    *run(scenario: string) {
      let modelCleaned = false;
      let modelReturned = false;
      const a = agent({
        maxSteps: 6,
        tools: {
          approval: tool({
            ...base,
            needsApproval: true,
            *execute() {
              return "approved";
            },
          }),
          wait: tool({
            ...base,
            *execute() {
              yield* r.signal("never");
              return null;
            },
          }),
          fail: tool({
            ...base,
            *execute() {
              throw new Error("unexpected tool failure");
            },
          }),
          failTerminal: tool({
            ...base,
            *execute() {
              throw new TerminalError("expected terminal failure");
            },
          }),
          sleep: sleepTool(),
          lookup: handlerTool({...base, call: () => r.client(child, "lookup").lookup()}),
          remote: handlerTool({
            ...base,
            call: () => {
              r.spawn(
                (function* () {
                  yield* r.sleep(10);
                  r.invocation(r.handlerRequest().id).signal("interrupt").resolve("cancel child");
                })(),
              );
              return r.client(child, "cancel").wait();
            },
          }),
          write: asyncTool({
            ...base,
            async execute() {
              effects.set(scenario, (effects.get(scenario) ?? 0) + 1);
              return "written";
            },
          }),
          program: programTool({tools: ["lookup", "write"]}),
        },
        *model(request): r.Operation<ModelResponse> {
          if (scenario === "interrupt") {
            try {
              r.invocation(r.handlerRequest().id).signal("interrupt").resolve("stop inference");
              yield* r.sleep(10);
              modelReturned = true;
              return final;
            } finally {
              modelCleaned = true;
            }
          }
          if ((scenario === "steering" || scenario === "steering-tools") && request.step === 1) {
            r.invocation(r.handlerRequest().id).signal("steering").resolve("new requirement");
            yield* r.sleep(10);
            if (scenario === "steering-tools") {
              return {type: "tool_calls", calls: [{id: "stale-write", name: "write", input: {}}]};
            }
            return {type: "final", text: "stale"};
          }
          if (scenario === "steering" || scenario === "steering-tools") {
            assert.match(JSON.stringify(request.messages), /new requirement/);
            return final;
          }
          if (request.step === 1) {
            let names: string[];
            switch (scenario) {
              case "failure":
                names = ["wait", "fail"];
                break;
              case "terminal-tool":
                names = ["failTerminal"];
                break;
              case "approval":
                names = ["approval"];
                break;
              case "rpc-cancel":
                names = ["remote"];
                break;
              case "program":
                names = ["program"];
                break;
              default:
                names = ["write", "lookup", "sleep"];
            }
            return {
              type: "tool_calls",
              calls: names.map((name): ToolCall => {
                if (name === "sleep") return {id: name, name, input: {milliseconds: 10}};
                if (name === "program") {
                  return {
                    id: name,
                    name,
                    input: {
                      source:
                        "async tools => await Promise.all([tools.lookup({}),tools.write({})])",
                    },
                  };
                }
                return {id: name, name, input: {}};
              }),
            };
          }
          return final;
        },
        *onApproval(request) {
          yield* r.run(async () => null, {name: "Publish approval"});
          r.invocation(request.invocationId).signal(request.signalName).resolve(true);
        },
      });
      try {
        return {
          result: yield* a.run("fixture", {
            steeringSignal: "steering",
            interruptSignal: "interrupt",
          }),
          modelCleaned,
          modelReturned,
        };
      } catch (error) {
        return {error: String(error), modelCleaned, modelReturned};
      }
    },
    *discovery() {
      const catalog = yield* restateTools({
        adminUrl: env.adminAPIBaseUrl(),
        allow: (target) => target.service === "SdkChild" && target.handler === "lookup",
      });
      const a = agent({
        tools: catalog.tools,
        *model(req): r.Operation<ModelResponse> {
          if (req.messages.some((m) => m.role === "tool")) return final;
          return {
            type: "tool_calls",
            calls: [{id: "discover", name: "lookupDiscovered", input: {key: "discovered"}}],
          };
        },
      });
      return yield* a.run("go");
    },
    *externalCancellation() {
      return yield* agent({
        *model(): r.Operation<ModelResponse> {
          r.invocation(r.handlerRequest().id).cancel();
          yield* r.sleep(60000);
          return final;
        },
      }).run("go");
    },
    *gateway() {
      return yield* agent({model: modelGateway(() => r.client(gateway).generate())}).run("go");
    },
  },
});
const session = r.object({
  name: "SdkConversation",
  handlers: {
    *persistTurn(ending: "completed" | "stopped" | "interrupted" | "failed") {
      const stored = new LazyStateConversation();
      let loads = 0;
      let appends = 0;
      const conversation: Conversation = {
        *load() {
          loads++;
          return yield* stored.load();
        },
        *append(messages, version) {
          appends++;
          return yield* stored.append(messages, version);
        },
        compact: () => stored.compact(),
      };
      const a = agent({
        maxSteps: ending === "stopped" ? 1 : 3,
        tools: {
          write: tool({
            ...base,
            *execute() {
              r.state().set("effect", "written");
              yield* r.sleep(1);
              return "written";
            },
          }),
        },
        *model(request): r.Operation<ModelResponse> {
          assert.deepEqual((yield* stored.page()).messages, []);
          if (request.step === 1)
            return {type: "tool_calls", calls: [{id: "write", name: "write", input: {}}]};
          if (ending === "failed") throw new TerminalError("failure after effect");
          if (ending === "interrupted") {
            r.invocation(r.handlerRequest().id).signal("interrupt").resolve("stop");
            yield* r.sleep(10);
          }
          return final;
        },
      });
      let status: string;
      try {
        status = (yield* a.run("go", {conversation, interruptSignal: "interrupt"})).status;
      } catch (error) {
        if (!(error instanceof TerminalError)) throw error;
        status = "failed";
      }
      return {
        status,
        loads,
        appends,
        messages: (yield* stored.page()).messages,
        effect: yield* r.state().get<string>("effect"),
      };
    },
    *approveOutput() {
      const conversation = new LazyStateConversation();
      const result = yield* agent({
        *model(): r.Operation<ModelResponse> {
          return {type: "final", text: "approved answer"};
        },
        *afterRun(candidate) {
          assert.equal(candidate.status, "completed");
          assert.equal(candidate.output, "approved answer");
          yield* r.sleep(1);
          // Returning nothing approves the candidate without returning lifecycle facts.
        },
      }).run("go", {conversation});
      return {result, history: yield* conversation.page()};
    },
    *interruptGuard() {
      const conversation = new LazyStateConversation();
      const result = yield* agent({
        *model(): r.Operation<ModelResponse> {
          return {type: "final", text: "unapproved candidate"};
        },
        *afterRun(result) {
          if (result.status === "completed") {
            r.invocation(r.handlerRequest().id)
              .signal("interrupt")
              .resolve("stop before publication");
            yield* r.sleep(60000);
          }
        },
      }).run("go", {conversation, interruptSignal: "interrupt"});
      return {result, history: yield* conversation.page()};
    },
    *turn(input: string) {
      const conversation = new LazyStateConversation({
        compaction: {
          policy: {maxMessages: 4, retainMessages: 2},
          model: function* (req) {
            return yield* r.run(
              async () => ({
                type: "final" as const,
                text: `summary: ${req.messages.length} inputs; preserve outstanding work`,
              }),
              {name: "summary"},
            );
          },
        },
      });
      const a = agent({
        *model(req): r.Operation<ModelResponse> {
          yield* r.sleep(2);
          return {
            type: "final",
            text: `answer to ${input}; ${req.messages.length} context messages`,
          };
        },
      });
      return yield* a.run(input, {conversation});
    },
    *history() {
      return yield* new LazyStateConversation().page();
    },
  },
});
// A Restate interface (contract) and its implementation, exercised through serviceTool.
const refundIface = r.iface.service("ServiceToolRefund", {
  issueRefund: r.iface.schemas({
    input: z.object({orderId: z.string(), amountCents: z.number()}),
    output: z.object({refundId: z.string()}),
    description: "Issue a refund for an order.",
  }),
  getPolicy: r.iface.json<void, {refundWindowDays: number}>(),
});
const refundService = r.implement(refundIface, {
  handlers: {
    *issueRefund({orderId}) {
      return {refundId: `re_${orderId}`};
    },
    *getPolicy() {
      return {refundWindowDays: 30};
    },
  },
});
const serviceToolHarness = r.service({
  name: "ServiceToolHarness",
  handlers: {
    // A single multiplexed tool routes to the handler the model selects.
    *multiplexed() {
      const result = yield* agent({
        maxSteps: 3,
        tools: {refund: serviceTool(refundIface)},
        *model(request): r.Operation<ModelResponse> {
          if (request.step === 1)
            return {
              type: "tool_calls",
              calls: [
                {
                  id: "r1",
                  name: "refund",
                  input: {handler: "issueRefund", input: {orderId: "O-1", amountCents: 500}},
                },
              ],
            };
          return final;
        },
      }).run("issue a refund");
      return {status: result.status, messages: result.messages};
    },
    // A scoped tool for a single void-input handler (empty input -> no argument).
    *scoped() {
      const result = yield* agent({
        maxSteps: 3,
        tools: {getPolicy: serviceTool({iface: refundIface, handler: "getPolicy"})},
        *model(request): r.Operation<ModelResponse> {
          if (request.step === 1)
            return {type: "tool_calls", calls: [{id: "p1", name: "getPolicy", input: {}}]};
          return final;
        },
      }).run("read the policy");
      return {status: result.status, messages: result.messages};
    },
  },
});
let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [runner, child, gateway, session, aiSession, refundService, serviceToolHarness],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});
void test(
  "native always-replay: concurrent runs isolate call budgets and history",
  {timeout: 20000},
  async () => {
    const runs = await connect({url: env.baseUrl()}).client(runner).concurrentRuns();
    assert.deepEqual(
      runs.map((result) => result.output),
      ["first", "second"],
    );
    assert.deepEqual(
      runs.map((result) => result.messages[0]),
      [
        {role: "user", content: "first"},
        {role: "user", content: "second"},
      ],
    );
  },
);
void test("native always-replay: steering retains bursts", {timeout: 20000}, async () => {
  const {result, signalsSent} = await connect({url: env.baseUrl()}).client(runner).steeringBursts();
  assert.equal(signalsSent, 2);
  assert.deepEqual(
    result.messages.filter((message) => message.role === "user").map((message) => message.content),
    [
      "go",
      '{"source":"agent-runtime","type":"steering","message":"first"}',
      '{"source":"agent-runtime","type":"steering","message":"second"}',
    ],
  );
  assert.equal(result.output, "done");
  assert.ok(
    !result.messages.some((message) => message.role === "assistant" && message.content === "stale"),
  );
});
for (const limit of ["calls", "depth"] as const) {
  void test(`native always-replay: shared tool ${limit} limit`, {timeout: 20000}, async () => {
    const result = await connect({url: env.baseUrl()}).client(runner).toolLimits(limit);
    assert.deepEqual(result.executed, ["outer", "nested"]);
    assert.match(
      result.error,
      limit === "calls" ? /Maximum tool calls exceeded/ : /Maximum nested tool depth exceeded/,
    );
    assert.equal(effects.get(`limit-${limit}`) ?? 0, 0);
  });
}
for (const scenario of [
  "parallel",
  "approval",
  "steering",
  "steering-tools",
  "interrupt",
  "failure",
  "terminal-tool",
  "program",
  "rpc-cancel",
]) {
  void test(`native always-replay: ${scenario}`, {timeout: 20000}, async () => {
    const result = await connect({url: env.baseUrl()}).client(runner).run(scenario);
    if (scenario === "failure") {
      assert.match(result.error!, /unexpected tool failure/);
      return;
    }
    assert.ok(result.result, JSON.stringify(result));
    assert.equal(
      result.result.status,
      scenario === "interrupt" || scenario === "rpc-cancel" ? "interrupted" : "completed",
    );
    if (scenario === "interrupt") {
      assert.equal(result.modelCleaned, true);
      assert.equal(result.modelReturned, false);
    }
    if (scenario === "terminal-tool") {
      const failure = result.result.messages.find((m) => m.role === "tool");
      assert.deepEqual(failure?.role === "tool" && failure.result, {
        status: "error",
        code: "tool_failed",
        message: "expected terminal failure",
      });
    }
    if (scenario === "parallel" || scenario === "program") assert.equal(effects.get(scenario), 1);
    if (scenario === "steering-tools") assert.equal(effects.get(scenario) ?? 0, 0);
    if (scenario === "parallel")
      assert.match(JSON.stringify(result.result.messages), /background-tool-result/);
    if (scenario === "steering")
      assert.ok(
        !result.result.messages.some((m) => m.role === "assistant" && m.content === "stale"),
      );
    if (scenario === "rpc-cancel") {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await env.stateOf(child, "cancel").get("cleaned")) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("child invocation was not cancelled");
    }
  });
}
void test(
  "native model gateway and durable conversation compaction",
  {timeout: 20000},
  async () => {
    const client = connect({url: env.baseUrl()});
    assert.equal((await client.client(runner).gateway()).status, "completed");
    const convo = client.client(session, "one");
    for (let i = 0; i < 4; i++)
      assert.equal((await convo.turn(`message ${i}`)).status, "completed");
    const transcript = await convo.history();
    assert.equal(transcript.messages.length, 8);
    assert.match(JSON.stringify(transcript.messages), /message 0/);
    const meta = await env
      .stateOf(session, "one")
      .get<{summary: {text: string}}>("conversation/meta");
    assert.match(meta!.summary.text, /preserve outstanding work/);
  },
);

void test("the embeddable session example exposes shared controls without model credentials", async () => {
  const client = connect({url: env.baseUrl()}).client(aiSession, "example");
  const status = await client.status();
  assert.equal(status.approval, null);
  assert.deepEqual(await client.history(), {messages: [], next: 0});
  assert.equal(await client.steer("new note"), false);
  assert.equal(await client.interrupt("stop"), false);
});

void test(
  "tool details survive forced replay and the native journal uses the display name",
  {timeout: 20000},
  async () => {
    const response = await connect({url: env.baseUrl()}).client(runner).toolInfo();
    assert.equal(response.result.status, "completed");
    assert.equal(effects.get("tool-info"), 1);
    const journal = await fetch(`${env.adminAPIBaseUrl()}/query`, {
      method: "POST",
      headers: {"Content-Type": "application/json", Accept: "application/json"},
      body: JSON.stringify({
        query: `SELECT name FROM sys_journal WHERE id = '${response.invocationId}' AND name = 'Close ticket'`,
      }),
    });
    assert.equal(journal.status, 200, await journal.clone().text());
    assert.match(await journal.text(), /Close ticket/);
  },
);

void test(
  "native output policy approves without returning lifecycle state",
  {timeout: 20000},
  async () => {
    const response = await connect({url: env.baseUrl()})
      .client(session, "output-approval")
      .approveOutput();
    assert.equal(response.result.status, "completed");
    assert.equal(response.result.steps, 1);
    assert.equal(response.result.output, "approved answer");
    assert.deepEqual(response.history.messages, [
      {role: "user", content: "go"},
      {role: "assistant", content: "approved answer"},
    ]);
    assert.deepEqual(response.result.messages, response.history.messages);
  },
);

void test(
  "native interrupted output guard never commits its candidate",
  {timeout: 20000},
  async () => {
    const response = await connect({url: env.baseUrl()})
      .client(session, "guard-interruption")
      .interruptGuard();
    assert.equal(response.result.status, "interrupted");
    assert.doesNotMatch(JSON.stringify(response), /unapproved candidate/);
    assert.deepEqual(response.history.messages, [{role: "user", content: "go"}]);
  },
);

void test(
  "native Restate discovery invokes the same snapshotted handler",
  {
    timeout: 20000,
  },
  async () => {
    const result = await connect({url: env.baseUrl()}).client(runner).discovery();
    assert.equal(result.status, "completed");
    assert.match(JSON.stringify(result.messages), /found/);
  },
);
void test(
  "external invocation cancellation stays cancellation across the agent boundary",
  {
    timeout: 20000,
  },
  async () => {
    await assert.rejects(
      connect({url: env.baseUrl()}).client(runner).externalCancellation(),
      /cancelled|canceled/i,
    );
  },
);
void test(
  "serviceTool routes a multiplexed call to the interface's handler and returns its result",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()}).client(serviceToolHarness).multiplexed();
    assert.equal(result.status, "completed");
    // The refund handler's result flows back through the tool into the transcript.
    assert.match(JSON.stringify(result.messages), /re_O-1/);
  },
);
void test(
  "serviceTool scoped to a void handler invokes it with no argument",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()}).client(serviceToolHarness).scoped();
    assert.equal(result.status, "completed");
    assert.match(JSON.stringify(result.messages), /refundWindowDays/);
  },
);

void test(
  "native always-replay: steering during beforeStep rejects stale tools",
  {timeout: 20000},
  async () => {
    const {result, writes} = await connect({url: env.baseUrl()})
      .client(runner)
      .steeringBeforeModel();
    assert.equal(result.output, "done");
    assert.equal(writes, 0);
    assert.equal(result.steps, 2);
  },
);

void test(
  "native always-replay: steering during a tool batch keeps FIFO order",
  {timeout: 20000},
  async () => {
    const {result, step} = await connect({url: env.baseUrl()}).client(runner).steeringDuringTool();
    assert.equal(result.output, "done");
    assert.ok(step >= 2);
    const steering = result.messages.flatMap((message) =>
      message.role === "user" && message.content.includes('"type":"steering"') ? [message] : [],
    );
    assert.deepEqual(
      steering.map((message) => message.content),
      [
        '{"source":"agent-runtime","type":"steering","message":"First revision"}',
        '{"source":"agent-runtime","type":"steering","message":"Second revision"}',
      ],
    );
    const toolIndex = result.messages.findIndex(
      (message) => message.role === "tool" && message.callId === "write",
    );
    assert.ok(toolIndex >= 0 && toolIndex < result.messages.indexOf(steering[0]!));
  },
);

void test(
  "native always-replay: steering can cancel a pending durable sleep",
  {timeout: 20000},
  async () => {
    const {result, step} = await connect({url: env.baseUrl()}).client(runner).steerPendingSleep();
    assert.equal(result.status, "completed");
    assert.equal(result.output, "done");
    assert.equal(step, 4);
    assert.ok(
      !result.messages.some(
        (message) => message.role === "assistant" && message.content === "stale",
      ),
    );
    const completion = result.messages.find(
      (message) => message.role === "user" && message.content.includes('"background-tool-result"'),
    );
    assert.ok(completion?.role === "user");
    assert.match(completion.content, /"status":"cancelled"/);
    const steeringIndex = result.messages.findIndex(
      (message) => message.role === "user" && message.content.includes('"type":"steering"'),
    );
    assert.ok(steeringIndex >= 0);
    assert.ok(steeringIndex < result.messages.indexOf(completion));
  },
);

for (const ending of ["completed", "stopped", "interrupted", "failed"] as const) {
  void test(
    `native always-replay: turn persistence after ${ending}`,
    {timeout: 20000},
    async () => {
      const result = await connect({url: env.baseUrl()})
        .client(session, `persist-${ending}`)
        .persistTurn(ending);
      assert.equal(result.status, ending);
      assert.equal(result.loads, 1);
      assert.equal(result.effect, "written");
      if (ending === "failed") {
        assert.equal(result.appends, 0);
        assert.deepEqual(result.messages, []);
      } else {
        assert.equal(result.appends, 1);
        assert.match(JSON.stringify(result.messages), /written/);
      }
    },
  );
}
