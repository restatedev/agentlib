import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {TerminalError} from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  asyncTool,
  cancelOperationTool,
  handoff,
  handlerTool,
  journaledModel,
  serviceTool,
  LazyStateConversation,
  sleepTool,
  tool,
  usageOf,
  type JsonValue,
  type ModelResponse,
  type ToolCall,
  type Conversation,
} from "@restatedev/agentlib";
import {programTool} from "@restatedev/agentlib/program";
import {restateTools} from "@restatedev/agentlib/discovery";
import {modelGateway} from "@restatedev/agentlib/provider";
import {aiSession} from "@restatedev/agentlib-examples/support-session";
const final: ModelResponse = {type: "final", text: "done"};
const base = {description: "fixture", input: z.object({})};
const effects = new Map<string, number>();
const reported = {
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 60,
  cacheWriteInputTokens: 20,
};
/** The run totals of `count` model calls that each report `reported`. */
const usageTotals = (count: number) => ({
  inputTokens: 100 * count,
  outputTokens: 10 * count,
  totalTokens: 110 * count,
  cachedInputTokens: 60 * count,
  cacheWriteInputTokens: 20 * count,
});
/** Counts each execution of `key`, then answers like a model reporting `reported`. */
function countedCall(key: string, response: ModelResponse): ModelResponse {
  effects.set(key, (effects.get(key) ?? 0) + 1);
  return {...response, usage: reported};
}
const sleepyRead = tool({
  ...base,
  *execute() {
    // A timer suspends the invocation, so the rest of the run replays.
    yield* r.sleep(5);
    return "page";
  },
});
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
      const result = yield* agent({
        *model(request) {
          if (request.step === 1) {
            steering.resolve("first");
            steering.resolve("second");
          }
          // Each steer discards the pending answer, so wait until both have arrived.
          if (!JSON.stringify(request.messages).includes("second")) {
            yield* r.sleep(60000);
            return {type: "final", text: "stale"};
          }
          return final;
        },
      }).run("go", {steeringSignal: "steering"});
      return {result};
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
            // Only the signal can end this wait; a short sleep would race it.
            yield* r.sleep(60000);
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
              return "written";
            },
          }),
        },
        *model(request): r.Operation<ModelResponse> {
          if (++step === 1)
            return {type: "tool_calls", calls: [{id: "write", name: "write", input: {}}]};
          // Steering discards this answer; wait until the second revision has arrived.
          if (!JSON.stringify(request.messages).includes("Second revision")) {
            yield* r.sleep(60000);
            return {type: "final", text: "stale"};
          }
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
              calls: [{id: "cancel", name: "cancel", input: {operationId: "sleep", reason: null}}],
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
        const result = yield* a.run("go");
        return {executed, stopped: result.status === "stopped" ? result.reason : undefined};
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
        finalize: false,
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
              // Only the signal can end this wait; a short sleep would race it.
              yield* r.sleep(60000);
              modelReturned = true;
              return final;
            } finally {
              modelCleaned = true;
            }
          }
          if ((scenario === "steering" || scenario === "steering-tools") && request.step === 1) {
            r.invocation(r.handlerRequest().id).signal("steering").resolve("new requirement");
            // Only the signal can end this wait; a short sleep would race it.
            yield* r.sleep(60000);
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
                      source: "return await Promise.all([tools.lookup({}),tools.write({})]);",
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
    *subAgentUsage() {
      const researcher = agent({
        tools: {read: sleepyRead},
        model: journaledModel(async (request): Promise<ModelResponse> => {
          if (request.step === 1)
            return countedCall("usage-research-1", {
              type: "tool_calls",
              calls: [{id: "s1", name: "read", input: {}}],
            });
          countedCall("usage-research-2", final);
          throw new TerminalError("Provider unavailable");
        }),
      });
      return yield* agent({
        tools: {research: agentTool(researcher, {description: "Research"})},
        model: journaledModel(async (request): Promise<ModelResponse> => {
          if (request.step !== 1) return countedCall("usage-lead-2", final);
          return countedCall("usage-lead-1", {
            type: "tool_calls",
            calls: [{id: "d1", name: "research", input: {task: "Look it up"}}],
          });
        }),
      }).run("Go");
    },
    *failedRunUsage() {
      try {
        return yield* agent({
          tools: {read: sleepyRead},
          model: journaledModel(async (request): Promise<ModelResponse> => {
            if (request.step === 1)
              return countedCall("usage-failed-1", {
                type: "tool_calls",
                calls: [{id: "r1", name: "read", input: {}}],
              });
            countedCall("usage-failed-2", final);
            throw new TerminalError("Provider unavailable");
          }),
        }).run("Go");
      } catch (error) {
        return usageOf(error);
      }
    },
    *repairToolInput() {
      const a = agent({
        model: journaledModel(async (request): Promise<ModelResponse> => {
          const results = request.messages.filter((message) => message.role === "tool");
          if (results.some((message) => message.callId === "repaired")) return final;
          if (results.length) {
            assert.equal(
              results.find((message) => message.callId === "invalid")?.result.status,
              "error",
            );
            return {type: "tool_calls", calls: [{id: "repaired", name: "write", input: "fixed"}]};
          }
          return {
            type: "tool_calls",
            calls: [
              {id: "valid", name: "write", input: "valid"},
              {id: "invalid", name: "write", input: "{", validationError: "Invalid JSON arguments"},
            ],
          };
        }),
        tools: {
          write: asyncTool({
            description: "Write a string",
            input: z.string(),
            async execute(value) {
              const key = `repair-${value}`;
              effects.set(key, (effects.get(key) ?? 0) + 1);
              return value;
            },
          }),
        },
      });
      return yield* a.run("Write");
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
        finalize: false,
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
            // Only the signal can end this wait; a short sleep would race it.
            yield* r.sleep(60000);
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
    *reasoningPolicy(redact: boolean) {
      const conversation = new LazyStateConversation();
      const reasoning = {
        items: [{type: "reasoning", text: "private thought"}],
        text: [
          {
            text: "private answer",
            providerOptions: {google: {thoughtSignature: "private signature"}},
          },
        ],
      };
      const a = agent({
        model: journaledModel(async (request): Promise<ModelResponse> => {
          const previous = request.messages.find((message) => message.role === "assistant");
          if (previous?.role === "assistant") {
            assert.deepEqual(previous.reasoning, redact ? undefined : reasoning);
            return {type: "final", text: "next answer"};
          }
          return {type: "final", text: "private answer", reasoning};
        }),
        *afterRun(candidate) {
          yield* r.sleep(1);
          if (redact && candidate.output === "private answer") return {output: "public answer"};
        },
      });
      const first = yield* a.run("first", {conversation});
      yield* a.run("next", {conversation});
      return {first, history: yield* conversation.page()};
    },
    *interruptGuard() {
      const conversation = new LazyStateConversation();
      const result = yield* agent({
        finalize: false,
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
// A keyed contract: one handler resolves its key from the input, one takes a scalar.
const counterIface = r.iface.object("ServiceToolCounter", {
  add: r.iface.schemas({
    input: z.object({counter: z.string(), amount: z.number()}),
    output: z.number(),
  }),
  bump: r.iface.schemas({input: z.number(), output: z.number()}),
  total: r.iface.json<void, number>(),
});
function* addToTotal(amount: number) {
  const total = ((yield* r.state().get<number>("total")) ?? 0) + amount;
  r.state().set("total", total);
  return total;
}
const counterService = r.implement(counterIface, {
  handlers: {
    *add({amount}) {
      return yield* addToTotal(amount);
    },
    *bump(amount) {
      return yield* addToTotal(amount);
    },
    *total() {
      return (yield* r.state().get<number>("total")) ?? 0;
    },
  },
});
const counterOf = (input: JsonValue) => (input as {counter: string}).counter;
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
    // Keys come from a resolver or a fixed string; a scalar input arrives unwrapped.
    *keyed() {
      const result = yield* agent({
        maxSteps: 3,
        tools: {
          add: serviceTool({iface: counterIface, handler: "add", key: counterOf}),
          bump: serviceTool({iface: counterIface, handler: "bump", key: "fixed"}),
          counter: serviceTool({iface: counterIface, key: counterOf}),
        },
        *model(request): r.Operation<ModelResponse> {
          if (request.step === 1)
            return {
              type: "tool_calls",
              calls: [
                {id: "a1", name: "add", input: {counter: "keyed-a", amount: 2}},
                {id: "b1", name: "bump", input: {value: 3}},
                {
                  id: "c1",
                  name: "counter",
                  input: {handler: "add", input: {counter: "keyed-c", amount: 7}},
                },
              ],
            };
          return final;
        },
      }).run("count");
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
      services: [
        runner,
        child,
        gateway,
        session,
        aiSession,
        refundService,
        counterService,
        serviceToolHarness,
      ],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});
void test("native always-replay: a failed sub-agent's usage counts once", async () => {
  const result = await connect({url: env.baseUrl()}).client(runner).subAgentUsage();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, usageTotals(3));
  for (const key of ["usage-lead-1", "usage-lead-2", "usage-research-1", "usage-research-2"])
    assert.equal(effects.get(key), 1, key);
});
void test("native always-replay: a failed run's error carries its usage", async () => {
  const usage = await connect({url: env.baseUrl()}).client(runner).failedRunUsage();
  assert.deepEqual(usage, usageTotals(1));
  assert.equal(effects.get("usage-failed-1"), 1);
  assert.equal(effects.get("usage-failed-2"), 1);
});
void test("native always-replay: only the invalid tool call needs correction", async () => {
  const result = await connect({url: env.baseUrl()}).client(runner).repairToolInput();
  assert.equal(result.status, "completed");
  assert.equal(effects.get("repair-valid"), 1);
  assert.equal(effects.get("repair-fixed"), 1);
  assert.equal(effects.get("repair-{"), undefined);
  const failed = result.messages.find(
    (message) => message.role === "tool" && message.callId === "invalid",
  );
  assert.deepEqual(failed?.role === "tool" && failed.result, {
    status: "error",
    code: "invalid_input",
    message: "Invalid JSON arguments",
  });
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
  const {result} = await connect({url: env.baseUrl()}).client(runner).steeringBursts();
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
    // A spent budget stops the run; nesting past the depth limit fails it.
    if (limit === "calls") assert.equal(result.stopped, "max_tool_calls");
    else assert.match(result.error ?? "", /Maximum nested tool depth exceeded/);
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
    if (scenario === "parallel" || scenario === "program")
      assert.equal(effects.get(scenario), 1, JSON.stringify(result.result.messages));
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
  assert.equal(await client.steer({message: "new note"}), false);
  assert.equal(await client.interrupt({reason: "stop"}), false);
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
  "native always-replay: output policies drop reasoning only for changed answers",
  {timeout: 20000},
  async () => {
    for (const redact of [false, true]) {
      const response = await connect({url: env.baseUrl()})
        .client(session, `reasoning-policy-${redact}`)
        .reasoningPolicy(redact);
      const answer = response.first.messages.at(-1);
      assert.equal(answer?.role, "assistant");
      if (answer?.role !== "assistant") throw new Error("Missing answer");
      assert.equal(answer.content, redact ? "public answer" : "private answer");
      assert.equal(answer.reasoning !== undefined, !redact);
      if (redact) assert.doesNotMatch(JSON.stringify(response), /private/);
      assert.deepEqual(response.history.messages[1], answer);
    }
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
  "serviceTool resolves object keys and unwraps scalar inputs",
  {timeout: 20000},
  async () => {
    const ingress = connect({url: env.baseUrl()});
    const result = await ingress.client(serviceToolHarness).keyed();
    assert.equal(result.status, "completed");
    const totals = await Promise.all(
      ["keyed-a", "fixed", "keyed-c"].map((key) => ingress.client(counterIface, key).total()),
    );
    assert.deepEqual(totals, [2, 3, 7]);
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
    // The steers can land during the batch or after it, so the step count varies.
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
