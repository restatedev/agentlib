// The three error outcomes, wherever a run throws them: a TerminalError (including
// a ToolError) reaches the model, an AgentTerminalError fails the run and every run
// around it, and any other error propagates for Restate to retry.
import assert from "node:assert/strict";
import {test} from "node:test";
import {CancelledError, TerminalError, TimeoutError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  AgentTerminalError,
  asyncTool,
  ContextOverflowError,
  ConversationConflictError,
  forkAgentTool,
  GuardrailError,
  handoff,
  isAgentTerminal,
  isContextOverflow,
  journaledModel,
  LazyStateConversation,
  messagesOf,
  RunFailedError,
  RunInputError,
  tool,
  ToolError,
  type AgentOptions,
  type Message,
  type ModelResponse,
  type ProgressEvent,
  type RunOptions,
  type Tool,
  type ToolResult,
} from "@restatedev/agentlib";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
import {memoryStore, testContext} from "./helpers.js";

const ctx = () => testContext("errors");
const done: ModelResponse = {type: "final", text: "done"};
const base = {description: "fixture", input: z.object({})};
const batch = (...names: string[]): ModelResponse => ({
  type: "tool_calls",
  calls: names.map((name) => ({id: name, name, input: {}})),
});
const ok = tool({
  ...base,
  *execute() {
    return "ok";
  },
});
const fail = (): never => {
  throw new TerminalError("boom");
};
const stop = (): never => {
  throw new AgentTerminalError("stop now");
};

/** The runtime error notes among the messages, parsed. */
function notes(messages: readonly Message[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !message.content.startsWith("{")) return [];
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    return parsed.type === "error" ? [parsed] : [];
  });
}
function results(messages: readonly Message[]): Record<string, ToolResult> {
  return Object.fromEntries(
    messages.flatMap((message) =>
      message.role === "tool" ? [[message.callId, message.result]] : [],
    ),
  );
}

void test("a TerminalError from any part of a tool call becomes that call's result", async () => {
  const sites: {
    site: string;
    work: Tool<undefined>;
    agent?: Partial<AgentOptions<undefined>>;
    run?: Partial<RunOptions<undefined>>;
  }[] = [
    {
      site: "execute",
      work: tool({
        ...base,
        *execute() {
          return fail();
        },
      }),
    },
    {
      site: "the tool's before",
      work: tool({
        ...base,
        *before() {
          return fail();
        },
        *execute() {
          return "ran";
        },
      }),
    },
    {
      site: "needsApproval",
      work: tool({
        ...base,
        *needsApproval() {
          return fail();
        },
        *execute() {
          return "ran";
        },
      }),
    },
    {
      site: "onApproval",
      work: tool({
        ...base,
        needsApproval: true,
        *execute() {
          return "ran";
        },
      }),
      agent: {
        *onApproval() {
          fail();
        },
      },
    },
    {
      site: "onHumanApproval",
      work: tool({
        ...base,
        needsApproval: true,
        *execute() {
          return "ran";
        },
      }),
      agent: {
        *onHumanApproval() {
          return fail();
        },
      },
    },
    {
      site: "the tool's after",
      work: tool({
        ...base,
        *execute() {
          return "ran";
        },
        *after() {
          return fail();
        },
      }),
    },
    {
      site: "beforeTool",
      work: tool({
        ...base,
        *execute() {
          return "ran";
        },
      }),
      agent: {
        *beforeTool(call) {
          if (call.name === "work") fail();
        },
      },
    },
    {
      site: "afterTool",
      work: tool({
        ...base,
        *execute() {
          return "ran";
        },
      }),
      agent: {
        *afterTool(output, context) {
          return context.toolName === "work" ? fail() : output;
        },
      },
    },
    {
      site: "a tool-start progress handler",
      work: tool({
        ...base,
        *execute() {
          return "ran";
        },
      }),
      run: {
        *onProgress(event) {
          if (event.type === "tool-start" && event.name === "work") fail();
        },
      },
    },
  ];
  for (const {site, work, agent: options, run} of sites) {
    const a = agent<undefined>({
      ...options,
      tools: {work, other: ok},
      *model(request): Generator<never, ModelResponse> {
        return request.step === 1 ? batch("work", "other") : done;
      },
    });
    const result = await r.execute(ctx(), a.run("go", run));
    assert.equal(result.status, "completed", site);
    // The agent's policies are guardrails: the model can tell them from the tool.
    const policy = site === "beforeTool" || site === "afterTool";
    const failed = policy
      ? {code: "guardrail_failed", message: "Policy check failed: boom"}
      : {code: "tool_failed", message: "boom"};
    assert.deepEqual(
      results(result.messages),
      {
        work: {status: "error", ...failed},
        other: {status: "success", output: "ok"},
      },
      site,
    );
    // The failed call used no extra step: the model saw it with its batch.
    assert.equal(result.steps, 2, site);
  }
});

void test("a guardrail's own ToolError keeps its code, and GuardrailError behaves like ToolError", async () => {
  const marked = new GuardrailError("Blocked by policy");
  assert.ok(marked instanceof ToolError && marked instanceof TerminalError);
  assert.equal(marked.toolCode, "guardrail_failed");
  assert.deepEqual(marked.metadata, {"agentlib.code": "guardrail_failed"});

  const a = agent({
    tools: {
      work: tool({
        ...base,
        *execute() {
          return "ran";
        },
      }),
      other: tool({
        ...base,
        *execute() {
          return "ran";
        },
      }),
    },
    *beforeTool(call) {
      if (call.name === "work") throw new ToolError("Remove the account number", "pii_detected");
      throw new GuardrailError("The policy service is down");
    },
    *model(request): Generator<never, ModelResponse> {
      return request.step === 1 ? batch("work", "other") : done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.deepEqual(results(result.messages), {
    work: {status: "error", code: "pii_detected", message: "Remove the account number"},
    other: {status: "error", code: "guardrail_failed", message: "The policy service is down"},
  });
});

void test("a ToolError gives the model its code, also through a nested call", async () => {
  const a = agent({
    tools: {
      lookup: tool({
        ...base,
        *execute() {
          throw new ToolError("No ticket 42", "not_found");
        },
      }),
      outer: tool({
        ...base,
        *execute(_, context) {
          return yield* context.callTool("lookup", {});
        },
      }),
    },
    *model(request) {
      return request.step === 1 ? batch("lookup", "outer") : done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.deepEqual(results(result.messages), {
    lookup: {status: "error", code: "not_found", message: "No ticket 42"},
    outer: {status: "error", code: "not_found", message: "No ticket 42"},
  });
});

void test("a TimeoutError in a tool reaches the model, which can try another approach", async () => {
  const a = agent({
    tools: {
      slow: tool({
        ...base,
        *execute() {
          throw new TimeoutError();
        },
      }),
      fast: ok,
    },
    *model(request) {
      if (request.step === 1) return batch("slow");
      if (request.step === 2) {
        assert.deepEqual(results(request.messages).slow, {
          status: "error",
          code: "tool_failed",
          message: "Timeout occurred",
        });
        return batch("fast");
      }
      return done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(results(result.messages).fast, {status: "success", output: "ok"});
});

void test("a hook's TerminalError becomes a note before the model's next call", async () => {
  // Each case fails once; `steps` counts the steps the run used.
  const cases: {
    origin: string;
    options: Partial<AgentOptions<undefined>>;
    code?: string;
    steps: number;
  }[] = [];
  const once = () => {
    let failed = false;
    return (error: () => never) => {
      if (failed) return;
      failed = true;
      error();
    };
  };
  {
    const failOnce = once();
    cases.push({
      origin: "beforeRun",
      options: {
        *beforeRun() {
          failOnce(() => {
            throw new ToolError("Remove the account number", "pii_detected");
          });
        },
      },
      code: "pii_detected",
      // The first model call still goes ahead.
      steps: 1,
    });
  }
  {
    const failOnce = once();
    cases.push({
      origin: "instructions",
      options: {
        *instructions() {
          failOnce(fail);
          return "Be brief.";
        },
      },
      // The step's model call is skipped, so the answer comes a step later.
      steps: 2,
    });
  }
  {
    const failOnce = once();
    cases.push({
      origin: "beforeStep",
      options: {
        *beforeStep() {
          failOnce(() => {
            throw new ToolError("Remove the account number", "pii_detected");
          });
        },
      },
      code: "pii_detected",
      steps: 2,
    });
  }
  for (const {origin, options, code, steps} of cases) {
    const seen: Record<string, unknown>[][] = [];
    const a = agent<undefined>({
      ...options,
      *model(request): Generator<never, ModelResponse> {
        seen.push(notes(request.messages));
        return done;
      },
    });
    const events: ProgressEvent[] = [];
    const result = await r.execute(
      ctx(),
      a.run("go", {
        *onProgress(event) {
          if (event.type === "error-note") events.push(event);
        },
      }),
    );
    assert.equal(result.status, "completed", origin);
    assert.equal(result.steps, steps, origin);
    // The model was called once, after the failure, and saw the note.
    const message = code ? "Remove the account number" : "boom";
    const details = {origin, ...(code ? {code} : {}), message};
    assert.deepEqual(seen, [[{source: "agent-runtime", type: "error", ...details}]], origin);
    // Notes are never saved or returned; a progress event reports each one.
    assert.deepEqual(notes(result.messages), [], origin);
    assert.deepEqual(events, [{type: "error-note", ...details}], origin);
  }
});

void test("a discarded model response and an afterRun rejection each report an error-note event", async () => {
  const events: ProgressEvent[] = [];
  const a = agent({
    maxOutputChars: 20,
    *afterRun(result) {
      if (result.status === "completed" && result.output === "short") return "Cite a source";
    },
    *model(request): Generator<never, ModelResponse> {
      const answers = ["far longer than the twenty character limit", "short", "short, cited"];
      return {type: "final", text: answers[request.step! - 1]!};
    },
  });
  const result = await r.execute(
    ctx(),
    a.run("go", {
      *onProgress(event) {
        if (event.type === "error-note") events.push(event);
      },
    }),
  );
  assert.equal(result.output, "short, cited");
  assert.deepEqual(
    events.map((event) => event.type === "error-note" && [event.origin, event.code]),
    [
      ["model", "output_limit"],
      ["afterRun", "denied"],
    ],
  );
});

void test("an afterRun TerminalError gives the model its answer back with a note", async () => {
  let reviewed = 0;
  const a = agent({
    *model(request) {
      if (request.step === 1) return {type: "final", text: "draft"};
      assert.deepEqual(request.messages.slice(-2), [
        {role: "assistant", content: "draft"},
        {
          role: "user",
          content:
            '{"source":"agent-runtime","type":"error","origin":"afterRun","message":"Cite your sources"}',
        },
      ]);
      return done;
    },
    *afterRun() {
      if (reviewed++ === 0) throw new TerminalError("Cite your sources");
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.output, "done");
  assert.deepEqual(result.messages, [
    {role: "user", content: "go"},
    {role: "assistant", content: "done"},
  ]);
});

void test("afterRun rejecting every completed answer ends as stopped", async () => {
  let calls = 0;
  const a = agent({
    maxSteps: 3,
    finalize: false,
    *model() {
      calls++;
      return done;
    },
    *afterRun(candidate) {
      // A stopped result has no answer for the model to revise, so it is accepted.
      if (candidate.status === "completed") return "Not good enough";
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status === "stopped" && result.reason, "max_steps");
  assert.equal(calls, 3);
  assert.deepEqual(result.messages, [{role: "user", content: "go"}]);
});

void test("afterRun failing for a stopped result fails the run: no model step follows", async () => {
  for (const [afterRun, expected] of [
    [
      function* () {
        throw new TerminalError("Summary rejected");
      },
      {name: "TerminalError", message: "Summary rejected"},
    ],
    [
      function* () {
        return "Summary rejected";
      },
      {name: "GuardrailError", message: "Summary rejected", toolCode: "denied"},
    ],
  ] as const) {
    const a = agent({
      maxSteps: 1,
      finalize: false,
      tools: {ok},
      *model() {
        return batch("ok");
      },
      afterRun,
    });
    await assert.rejects(r.execute(ctx(), a.run("go")), expected);
  }
});

void test("a model that throws a TerminalError ends the run: another call would fail too", async () => {
  let calls = 0;
  const a = agent({
    *model() {
      calls++;
      throw new TerminalError("Provider unavailable");
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go")), {message: "Provider unavailable"});
  assert.equal(calls, 1);
});

void test("a model call whose configured attempts run out ends the run", async () => {
  let calls = 0;
  const a = agent({
    model: journaledModel(
      async () => {
        calls++;
        throw new Error("upstream down");
      },
      {retry: {maxAttempts: 1}},
    ),
  });
  const handler = (context: Context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return {failed: false};
        } catch (error) {
          return {failed: true, message: (error as Error).message};
        }
      })(),
    );
  const live = await runHandler(handler);
  // A single attempt is spent at once, and the step fails terminally.
  assert.deepEqual(live.output, {failed: true, message: "upstream down"});
  assert.equal(calls, 1);
});

void test("a TerminalError in beforeSteering rejects the message, and the run continues", async () => {
  const events: ProgressEvent[] = [];
  const result = await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        checked = r.channel<void>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        *model() {
          yield* change.send("Use the other account");
          yield* checked.receive;
          return {type: "final", text: "kept"};
        },
        *beforeSteering() {
          yield* checked.send();
          throw new TerminalError("Moderation service rejected the request");
        },
      });
      return yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
        *onProgress(event) {
          if (event.type.startsWith("steering")) events.push(event);
        },
      });
    })(),
  );
  assert.equal(result.output, "kept");
  assert.doesNotMatch(JSON.stringify(result.messages), /other account/);
  assert.deepEqual(events, [
    {type: "steering-rejected", reason: "Moderation service rejected the request"},
  ]);
});

void test("an AgentTerminalError fails the run from anywhere, and the conversation keeps the failed turn", async () => {
  const sites: Record<string, Partial<AgentOptions<undefined>>> = {
    "a tool": {
      tools: {
        work: tool({
          ...base,
          *execute() {
            return stop();
          },
        }),
      },
    },
    "the tool's before": {
      tools: {
        work: tool({
          ...base,
          *before() {
            return stop();
          },
          *execute() {
            return "ran";
          },
        }),
      },
    },
    beforeTool: {
      tools: {work: ok},
      *beforeTool() {
        stop();
      },
    },
    afterTool: {
      tools: {work: ok},
      *afterTool() {
        return stop();
      },
    },
    beforeRun: {
      *beforeRun() {
        stop();
      },
    },
    instructions: {
      *instructions() {
        return stop();
      },
    },
    beforeStep: {
      *beforeStep() {
        stop();
      },
    },
    afterRun: {
      *afterRun() {
        stop();
      },
    },
    "the model": {
      *model() {
        return stop();
      },
    },
  };
  for (const [site, options] of Object.entries(sites)) {
    const {store} = memoryStore();
    const conversation = new LazyStateConversation({store});
    const a = agent<undefined>({
      *model(request) {
        return request.step === 1 && options.tools ? batch("work") : done;
      },
      ...options,
    });
    let failure: unknown;
    await assert.rejects(
      r.execute(ctx(), a.run("go", {conversation})),
      (error) => {
        failure = error;
        return error instanceof AgentTerminalError && error.message === "stop now";
      },
      site,
    );
    const saved = await r.execute(
      ctx(),
      (function* () {
        return (yield* conversation.load()).messages;
      })(),
    );
    if (site === "beforeRun") {
      // Stopping in beforeRun keeps the input out of the history.
      assert.deepEqual(saved, [], site);
      assert.equal(messagesOf(failure), undefined, site);
      continue;
    }
    // Every saved call has a result, and the next run reads why this one failed.
    history(saved);
    assert.deepEqual(saved, messagesOf(failure), site);
    assert.deepEqual(saved[0], {role: "user", content: "go"}, site);
    assert.deepEqual(
      saved.at(-1),
      {
        role: "user",
        content: JSON.stringify({source: "agent-runtime", type: "run-failed", message: "stop now"}),
      },
      site,
    );
    const results = saved.flatMap((message) => (message.role === "tool" ? [message.result] : []));
    assert.deepEqual(
      results,
      options.tools ? [{status: "cancelled", message: "Run failed: stop now"}] : [],
      site,
    );
  }
});

void test("an AgentTerminalError interrupts the other calls in its batch", async () => {
  let cleaned = false;
  const a = agent({
    tools: {
      slow: tool({
        ...base,
        *execute() {
          try {
            yield* r.channel<void>().receive;
            return "unreachable";
          } finally {
            cleaned = true;
          }
        },
      }),
      stop: tool({
        ...base,
        *execute() {
          return stop();
        },
      }),
    },
    *model() {
      return batch("slow", "stop");
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go")), {name: "AgentTerminalError"});
  assert.equal(cleaned, true);
});

void test("an AgentTerminalError from a sub-agent's tool fails the parent run too", async () => {
  let parentCalls = 0;
  const researcher = agent({
    tools: {
      lookup: tool({
        ...base,
        *execute() {
          return stop();
        },
      }),
    },
    *model() {
      return batch("lookup");
    },
  });
  const lead = agent({
    tools: {research: agentTool(researcher, {description: "Research"})},
    *model() {
      parentCalls++;
      return {
        type: "tool_calls",
        calls: [{id: "r", name: "research", input: {task: "Look it up"}}],
      };
    },
  });
  await assert.rejects(r.execute(ctx(), lead.run("go")), {name: "AgentTerminalError"});
  assert.equal(parentCalls, 1);
});

void test("an AgentTerminalError from a fork's tool fails the parent run too", async () => {
  let parentCalls = 0;
  let forkCalls = 0;
  const a = agent({
    tools: {
      fork: forkAgentTool(),
      stop: tool({
        ...base,
        *execute() {
          return stop();
        },
      }),
    },
    *model(request) {
      if (JSON.stringify(request.messages).includes("[Forked sub-agent]")) {
        forkCalls++;
        return batch("stop");
      }
      parentCalls++;
      return {type: "tool_calls", calls: [{id: "f", name: "fork", input: {task: "Check it"}}]};
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go")), {name: "AgentTerminalError"});
  assert.deepEqual({parentCalls, forkCalls}, {parentCalls: 1, forkCalls: 1});
});

void test("a sub-agent's or fork's events reach the parent whatever the parent's output limit", async () => {
  // Within the sub-agent's own limit, past the parent's.
  const big = tool({
    ...base,
    *execute() {
      return "x".repeat(5000);
    },
  });
  // A fork shares the parent's limit: a result just within it makes a larger event.
  const near = tool({
    ...base,
    *execute() {
      return "x".repeat(1950);
    },
  });
  const sub = agent({
    tools: {big},
    codeMode: false,
    *model(request): Generator<never, ModelResponse> {
      return request.step === 1 ? batch("big") : done;
    },
  });
  for (const via of ["agentTool", "fork"] as const) {
    let forwarded = 0;
    const a = agent({
      maxOutputChars: 2000,
      codeMode: false,
      tools:
        via === "fork"
          ? {big: near, fork: forkAgentTool()}
          : {delegate: agentTool(sub, {description: "Delegate"})},
      *model(request): Generator<never, ModelResponse> {
        const forked = JSON.stringify(request.messages).includes("[Forked sub-agent]");
        if (forked)
          return request.messages.some((m) => m.role === "tool" && m.callId === "big")
            ? done
            : batch("big");
        if (request.step! > 1) return done;
        const name = via === "fork" ? "fork" : "delegate";
        return {type: "tool_calls", calls: [{id: name, name, input: {task: "Look"}}]};
      },
    });
    const result = await r.execute(
      ctx(),
      a.run("go", {
        *onProgress(event) {
          if (event.type === "tool-progress" && JSON.stringify(event.value).length > 2000)
            forwarded++;
        },
      }),
    );
    assert.equal(result.status, "completed", via);
    assert.ok(forwarded > 0, via);
  }
  // A tool's own progress still has to fit.
  const noisy = agent({
    maxOutputChars: 2000,
    codeMode: false,
    tools: {
      noisy: tool({
        ...base,
        *execute(_input, context) {
          yield* context.progress("x".repeat(3000));
          return "ok";
        },
      }),
    },
    *model(request): Generator<never, ModelResponse> {
      return request.step === 1 ? batch("noisy") : done;
    },
  });
  await assert.rejects(r.execute(ctx(), noisy.run("go")), RangeError);
});

void test("an AgentTerminalError with code 413 is not a context overflow", async () => {
  const tooLarge = () => new AgentTerminalError("The upload is too large", {errorCode: 413});
  assert.ok(!isContextOverflow(tooLarge()));
  // The same metadata after a journaled step or an RPC.
  assert.ok(
    !isContextOverflow(new TerminalError("m", {errorCode: 413, metadata: tooLarge().metadata})),
  );
  assert.ok(isContextOverflow(new ContextOverflowError("m")));

  // An overflow would compact the conversation and call the model again.
  let calls = 0;
  const direct = agent({
    *model() {
      calls++;
      throw tooLarge();
    },
  });
  await assert.rejects(r.execute(ctx(), direct.run("go")), {name: "AgentTerminalError"});
  assert.equal(calls, 1);

  // In a sub-agent, an overflow would become the parent's tool_failed result.
  let parentCalls = 0;
  const lead = agent({
    tools: {research: agentTool(direct, {description: "Research"})},
    *model() {
      parentCalls++;
      return {
        type: "tool_calls",
        calls: [{id: "r", name: "research", input: {task: "Look it up"}}],
      };
    },
  });
  await assert.rejects(r.execute(ctx(), lead.run("go")), {name: "AgentTerminalError"});
  assert.equal(parentCalls, 1);
});

void test("an AgentTerminalError thrown inside an asyncTool fails the run, also on replay", async () => {
  let effects = 0;
  const a = agent({
    tools: {
      charge: asyncTool({
        ...base,
        async execute() {
          effects++;
          throw new AgentTerminalError("The account is closed");
        },
      }),
    },
    *model(request) {
      return yield* r.run(async () => (request.step === 1 ? batch("charge") : done), {
        name: "model",
      });
    },
  });
  const handler = (context: Context) =>
    r.execute(
      context,
      (function* () {
        try {
          yield* a.run("go");
          return {failed: false};
        } catch (error) {
          // The journal rebuilt the error as a plain TerminalError; its metadata says what it is.
          return {
            failed: true,
            agentTerminal: isAgentTerminal(error),
            message: (error as Error).message,
          };
        }
      })(),
    );
  const live = await runHandler(handler);
  assert.deepEqual(live.output, {
    failed: true,
    agentTerminal: true,
    message: "The account is closed",
  });
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(effects, 1);
});

void test("cancellation propagates from anywhere and never reaches the model", async () => {
  // What the SDK throws at the next await once the invocation is cancelled.
  const cancel = (): never => {
    throw new CancelledError();
  };
  const sites: Record<string, Partial<AgentOptions<undefined>>> = {
    "a tool": {
      tools: {
        work: tool({
          ...base,
          *execute() {
            return cancel();
          },
        }),
      },
    },
    beforeTool: {
      tools: {work: ok},
      *beforeTool() {
        cancel();
      },
    },
    beforeRun: {
      *beforeRun() {
        cancel();
      },
    },
    instructions: {
      *instructions() {
        return cancel();
      },
    },
    beforeStep: {
      *beforeStep() {
        cancel();
      },
    },
    afterRun: {
      *afterRun() {
        cancel();
      },
    },
    "the model": {
      *model() {
        return cancel();
      },
    },
  };
  for (const [site, options] of Object.entries(sites)) {
    let calls = 0;
    const a = agent<undefined>({
      *model(request): Generator<never, ModelResponse> {
        calls++;
        return request.step === 1 && options.tools ? batch("work") : done;
      },
      ...options,
    });
    await assert.rejects(r.execute(ctx(), a.run("go")), CancelledError, site);
    // No model call came after the cancellation to receive it.
    const expected = {"a tool": 1, beforeTool: 1, afterRun: 1}[site] ?? 0;
    assert.equal(calls, expected, site);
  }
});

void test("an error that isn't terminal propagates for Restate to retry", async () => {
  for (const options of [
    {
      tools: {
        work: tool({
          ...base,
          *execute(): Generator<never, never> {
            throw new Error("database offline");
          },
        }),
      },
    },
    {
      *beforeStep(): Generator<never, void> {
        throw new Error("database offline");
      },
    },
    {
      *afterRun(): Generator<never, void> {
        throw new Error("database offline");
      },
    },
  ] as Partial<AgentOptions<undefined>>[]) {
    const a = agent<undefined>({
      *model(request) {
        return request.step === 1 && options.tools ? batch("work") : done;
      },
      ...options,
    });
    await assert.rejects(r.execute(ctx(), a.run("go")), (error) => {
      assert.ok(!(error instanceof TerminalError));
      assert.equal((error as Error).message, "database offline");
      return true;
    });
  }
});

void test("a nested call past maxToolDepth fails alone, and the tool that made it can recover", async () => {
  const a = agent({
    maxToolDepth: 1,
    tools: {
      outer: tool({
        ...base,
        *execute(_, context) {
          try {
            return yield* context.callTool("middle", {});
          } catch (error) {
            return {recovered: error instanceof ToolError ? error.toolCode : "unknown"};
          }
        },
      }),
      middle: tool({
        ...base,
        *execute(_, context) {
          return yield* context.callTool("inner", {});
        },
      }),
      inner: ok,
    },
    *model(request) {
      return request.step === 1 ? batch("outer") : done;
    },
  });
  const result = await r.execute(ctx(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.deepEqual(results(result.messages).outer, {
    status: "success",
    output: {recovered: "depth_limit"},
  });
});

void test("agent() rejects tools no run could list when it is defined", () => {
  const model = function* (): Generator<never, ModelResponse> {
    return done;
  };
  assert.throws(() => agent({model, tools: {"look up": ok}}), /Invalid tool name: look up/);
  const specialist = agent({model});
  assert.throws(
    () => agent({model, tools: {transfer: {...handoff(specialist), background: true}}}),
    /Handoff tool must be foreground: transfer/,
  );
});

void test("a failed conversation compaction lets the run continue with the history it loaded", async () => {
  const history: Message[] = [
    {role: "user", content: "first"},
    {role: "assistant", content: "one"},
    {role: "user", content: "second"},
    {role: "assistant", content: "two"},
  ];
  const compactingWith = (failure: () => never) => {
    const {store} = memoryStore();
    return new LazyStateConversation({
      store,
      compaction: {
        *model() {
          return failure();
        },
        policy: {maxMessages: 2, retainMessages: 1},
      },
    });
  };
  let seen: Message[] = [];
  const a = agent({
    *model(request) {
      seen = request.messages;
      return done;
    },
  });
  const result = await r.execute(
    ctx(),
    (function* () {
      const conversation = compactingWith(fail);
      yield* conversation.append(history, 0);
      return yield* a.run("third", {conversation});
    })(),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [...history, {role: "user", content: "third"}]);

  // An AgentTerminalError from the compaction model still fails the run.
  await assert.rejects(
    r.execute(
      ctx(),
      (function* () {
        const conversation = compactingWith(stop);
        yield* conversation.append(history, 0);
        return yield* a.run("third", {conversation});
      })(),
    ),
    {name: "AgentTerminalError"},
  );
});

void test("an AgentTerminalError from the finalization model fails the run", async () => {
  const a = agent({
    maxSteps: 1,
    tools: {ok},
    *model() {
      return batch("ok");
    },
    *finalize() {
      return stop();
    },
  });
  await assert.rejects(r.execute(ctx(), a.run("go")), {name: "AgentTerminalError"});
});

void test("agent errors survive the journal and RPC through their metadata", () => {
  const stopped = new AgentTerminalError("stop", {errorCode: 409});
  assert.ok(stopped instanceof TerminalError);
  assert.equal(stopped.code, 409);
  assert.ok(isAgentTerminal(stopped));
  // What a journaled step or an RPC rebuilds: a plain TerminalError with the metadata.
  const rebuilt = new TerminalError("stop", {metadata: {...stopped.metadata}});
  assert.ok(isAgentTerminal(rebuilt));
  assert.ok(!isAgentTerminal(new TerminalError("stop")));

  const missing = new ToolError("No ticket 42", "not_found");
  assert.ok(missing instanceof TerminalError);
  assert.equal(missing.toolCode, "not_found");
  assert.equal(missing.code, 500);
  assert.deepEqual(missing.metadata, {"agentlib.code": "not_found"});
  assert.ok(!isAgentTerminal(missing));
});

void test("every exported error class has a name", () => {
  const named: [new (message: string) => Error, string][] = [
    [AgentTerminalError, "AgentTerminalError"],
    [RunFailedError, "AgentTerminalError"],
    [ToolError, "ToolError"],
    [GuardrailError, "GuardrailError"],
    [RunInputError, "RunInputError"],
    [ContextOverflowError, "ContextOverflowError"],
    [ConversationConflictError, "ConversationConflictError"],
  ];
  for (const [ErrorClass, name] of named) assert.equal(new ErrorClass("m").name, name);
});
