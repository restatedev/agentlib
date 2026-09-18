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
  handoff,
  handlerTool,
  LazyStateConversation,
  sleepTool,
  tool,
  type ModelResponse,
  type AgentUpdate,
  type ToolCall,
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
              const updates: AgentUpdate[] = [];
              const result = yield* a.run(name, {
                name,
                context: {owner: name},
                *onUpdate(update) {
                  updates.push(update);
                },
              });
              return {result, updates};
            })(),
          ),
        ),
      );
    },
    *streamFailure() {
      const fail = r.channel<void>();
      const stream = yield* agent({
        *model() {
          yield* fail.receive;
          yield* r.sleep(5);
          throw new TerminalError("expected producer failure");
        },
      }).stream("go");
      const first = yield* stream.next();
      yield* fail.send();
      try {
        yield* stream.next();
        return {first, error: "Expected the next read to throw"};
      } catch (error) {
        return {first, error: String(error)};
      }
    },
    *steeringBursts() {
      const steering = r.invocation(r.handlerRequest().id).signal<string>("steering");
      const steered = r.channel<void>();
      const updates: AgentUpdate[] = [];
      const result = yield* agent({
        *model(request) {
          if (request.step === 1) {
            steering.resolve("first");
            steering.resolve("second");
            yield* steered.receive;
            return {type: "final", text: "stale"};
          }
          return final;
        },
        *onUpdate(update) {
          updates.push(update);
          if (update.type === "steering" && update.message === "first") {
            // Another arrival while the previous batch is being processed.
            steering.resolve("third");
            yield* r.sleep(5);
          }
          if (update.type === "steering" && update.message === "third") yield* steered.send();
        },
      }).run("go", {steeringSignal: "steering"});
      return {result, updates};
    },
    *streamBursts() {
      const buffered = r.channel<void>();
      const resume = r.channel<void>();
      const stream = yield* agent({
        tools: {
          report: tool({
            ...base,
            *execute(_, context) {
              yield* context.progress(1);
              yield* context.progress(2);
              yield* buffered.send();
              yield* resume.receive;
              yield* r.sleep(5);
              yield* context.progress(3);
              return "reported";
            },
          }),
        },
        *model(request) {
          if (request.step === 1) {
            return {type: "tool_calls", calls: [{id: "report", name: "report", input: {}}]};
          }
          return final;
        },
      }).stream("go");
      // Let the producer buffer several updates before the first read.
      yield* buffered.receive;
      const updates: AgentUpdate[] = [];
      while (true) {
        const next = yield* stream.next();
        if (next.done) break;
        updates.push(next.value);
        // The queue is empty here; the next update must wake a fresh waiter.
        if (next.value.type === "progress" && next.value.value === 2) yield* resume.send();
      }
      return {updates, result: yield* stream.result};
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
      const updates: AgentUpdate[] = [];
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
        *onUpdate(update) {
          updates.push(update);
        },
      }).run("Close T-42");
      return {result, updates, invocationId: r.handlerRequest().id};
    },
    *run(scenario: string) {
      const updates: string[] = [];
      let modelCleaned = false;
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
              throw new TerminalError("expected terminal failure");
            },
          }),
          sleep: sleepTool(),
          lookup: handlerTool({...base, call: () => r.client(child, "lookup").lookup()}),
          remote: handlerTool({...base, call: () => r.client(child, "cancel").wait()}),
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
              yield* r.sleep(60000);
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
        *onUpdate(event) {
          updates.push(event.type);
          if (scenario === "late-interrupt" && event.type === "run-end")
            r.invocation(r.handlerRequest().id).signal("interrupt").resolve("after acceptance");
          if (scenario === "rpc-cancel" && event.type === "tool-start") {
            r.spawn(
              (function* () {
                yield* r.sleep(10);
                r.invocation(r.handlerRequest().id).signal("interrupt").resolve("cancel child");
              })(),
            );
          }
          yield* r.run(async () => null, {name: `event:${event.id}`});
        },
      });
      try {
        return {
          result: yield* a.run("fixture", {
            steeringSignal: "steering",
            interruptSignal: "interrupt",
          }),
          updates,
          modelCleaned,
        };
      } catch (error) {
        return {error: String(error), updates, modelCleaned};
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
    *approveOutput() {
      const conversation = new LazyStateConversation();
      const outputs: unknown[] = [];
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
        *onUpdate(update) {
          if (update.type === "run-end") outputs.push(update.output);
        },
      }).run("go", {conversation});
      return {result, outputs, history: yield* conversation.page()};
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
let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [runner, child, gateway, session, aiSession],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});
void test(
  "native always-replay: concurrent runs isolate call budgets, history, and updates",
  {timeout: 20000},
  async () => {
    const runs = await connect({url: env.baseUrl()}).client(runner).concurrentRuns();
    assert.deepEqual(
      runs.map(({result}) => result.output),
      ["first", "second"],
    );
    assert.deepEqual(
      runs.map(({result}) => result.messages[0]),
      [
        {role: "user", content: "first"},
        {role: "user", content: "second"},
      ],
    );
    for (const {updates} of runs)
      assert.deepEqual(
        updates.map((update) => update.sequence),
        [1, 2, 3, 4, 5],
      );
    assert.equal(new Set(runs.flatMap(({updates}) => updates.map((update) => update.id))).size, 10);
  },
);
void test(
  "native always-replay: producer failure wakes an empty stream reader",
  {timeout: 20000},
  async () => {
    const {first, error} = await connect({url: env.baseUrl()}).client(runner).streamFailure();
    assert.equal(first.done, false);
    assert.equal(first.value?.type, "step-start");
    assert.match(error, /expected producer failure/);
  },
);
void test(
  "native always-replay: steering retains bursts and arrivals during draining",
  {timeout: 20000},
  async () => {
    const {result, updates} = await connect({url: env.baseUrl()}).client(runner).steeringBursts();
    assert.deepEqual(
      updates.filter((update) => update.type === "steering").map((update) => update.message),
      ["first", "second", "third"],
    );
    assert.deepEqual(
      result.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
      [
        "go",
        '{"source":"agent-runtime","type":"steering","message":"first"}',
        '{"source":"agent-runtime","type":"steering","message":"second"}',
        '{"source":"agent-runtime","type":"steering","message":"third"}',
      ],
    );
    assert.equal(result.output, "done");
    assert.ok(
      !result.messages.some(
        (message) => message.role === "assistant" && message.content === "stale",
      ),
    );
  },
);
void test(
  "native always-replay: stream retains bursts and wakes again after draining",
  {timeout: 20000},
  async () => {
    const {updates, result} = await connect({url: env.baseUrl()}).client(runner).streamBursts();
    assert.deepEqual(
      updates.filter((update) => update.type === "progress").map((update) => update.value),
      [1, 2, 3],
    );
    assert.deepEqual(
      updates.map((update) => update.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(updates.at(-1)?.type, "run-end");
    assert.equal(result.status, "completed");
  },
);
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
  "late-interrupt",
  "failure",
  "program",
  "rpc-cancel",
]) {
  void test(`native always-replay: ${scenario}`, {timeout: 20000}, async () => {
    const result = await connect({url: env.baseUrl()}).client(runner).run(scenario);
    if (scenario === "failure") {
      assert.match(result.error!, /expected terminal failure/);
      return;
    }
    assert.ok(result.result, JSON.stringify(result));
    assert.equal(
      result.result.status,
      scenario === "interrupt" || scenario === "rpc-cancel" ? "interrupted" : "completed",
    );
    if (scenario === "interrupt") assert.equal(result.modelCleaned, true);
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
  assert.deepEqual(status.updates, []);
  assert.deepEqual(await client.history(), {messages: [], next: 0});
  assert.equal(await client.steer("new note"), false);
  assert.equal(await client.interrupt("stop"), false);
});

void test(
  "tool details survive forced replay and the native journal uses the display name",
  {timeout: 20000},
  async () => {
    const response = await connect({url: env.baseUrl()}).client(runner).toolInfo();
    const metadata = response.updates.find((update) => update.type === "tool-info");
    assert.ok(metadata && metadata.type === "tool-info");
    assert.deepEqual(metadata.info, {name: "Close ticket", details: {ticketId: "T-42"}});
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
    assert.deepEqual(response.outputs, ["approved answer"]);
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
