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
import {aiSession} from "@restate-agents/examples/session";
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
          return request.step === 1
            ? {
                type: "tool_calls",
                calls: [
                  {id: "close", name: "closeTicket", input: {ticketId: "T-42", reason: "Resolved"}},
                ],
              }
            : final;
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
            return scenario === "steering-tools"
              ? {type: "tool_calls", calls: [{id: "stale-write", name: "write", input: {}}]}
              : {type: "final", text: "stale"};
          }
          if (scenario === "steering" || scenario === "steering-tools") {
            assert.match(JSON.stringify(request.messages), /new requirement/);
            return final;
          }
          if (request.step === 1) {
            const names =
              scenario === "failure"
                ? ["wait", "fail"]
                : scenario === "approval"
                  ? ["approval"]
                  : scenario === "rpc-cancel"
                    ? ["remote"]
                    : scenario === "program"
                      ? ["program"]
                      : ["write", "lookup", "sleep"];
            return {
              type: "tool_calls",
              calls: names.map((name): ToolCall => ({
                id: name,
                name,
                input:
                  name === "sleep"
                    ? {milliseconds: 10}
                    : name === "program"
                      ? {
                          source:
                            "async tools => await Promise.all([tools.lookup({}),tools.write({})])",
                        }
                      : {},
              })),
            };
          }
          return final;
        },
        *onUpdate(event) {
          updates.push(event.type);
          if (scenario === "late-interrupt" && event.type === "run-end")
            r.invocation(r.handlerRequest().id).signal("interrupt").resolve("after acceptance");
          if (event.type === "approval-required")
            r.invocation(r.handlerRequest().id).signal(event.request.signalName).resolve(true);
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
          return req.messages.some((m) => m.role === "tool")
            ? final
            : {
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
  assert.deepEqual(status.approvals, []);
  assert.deepEqual(status.updates, []);
  assert.deepEqual(await client.history(), {messages: [], next: 0});
  assert.equal(await client.steer("new note"), false);
  assert.equal(await client.interrupt("stop"), false);
  assert.equal(await client.approve({signalName: "unknown", approved: true}), false);
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
