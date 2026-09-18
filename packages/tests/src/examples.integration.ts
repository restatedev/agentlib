import assert from "node:assert/strict";
import {after, before, mock, test} from "node:test";
import {TerminalError} from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import * as r from "@restatedev/restate-sdk-gen";
import {journaledModel, type Message, type Model, type ModelResponse} from "@restate-agents/core";

const sources = [
  {
    id: "durability",
    title: "Recovery",
    text: "Completed journal entries are replayed without repeating the action.",
  },
  {
    id: "idempotency",
    title: "External effects",
    text: "Use stable idempotency keys for external mutations.",
  },
];
const effects = new Map<string, number>();
const cleanedRaces = new Set<string>();
const answer = (output: unknown): ModelResponse => ({type: "final", text: JSON.stringify(output)});

// Both workers must reach this barrier before either can finish: serialization
// would deadlock and fail the test's timeout.
const barrier = r.object({
  name: "ResearchBarrier",
  handlers: {
    *arrive(id: string) {
      const participants = (yield* r.state().get<string[]>("participants")) ?? [];
      participants.push(id);
      r.state().set("participants", participants);
      if (participants.length === 2)
        for (const participant of participants)
          r.invocation(participant).signal("workers-ready").resolve(true);
    },
  },
});

const researchModel: Model = function* (request) {
  const role = request.instructions!.split(".")[0];
  const invocationId = r.handlerRequest().id;
  if (role === "Research worker" && prompt(request) === "cite without reading") {
    return answer({answer: "Unsupported claim", sourceIds: ["durability"]});
  }
  if (role === "Research worker" && request.step === 1) {
    yield* r.client(barrier, "parallel").arrive(invocationId);
    yield* r.signal("workers-ready");
  }
  return yield* r.run(
    async (): Promise<ModelResponse> => {
      const key = `${invocationId}:${role}:${request.step}`;
      effects.set(key, (effects.get(key) ?? 0) + 1);
      if (role === "Research planner")
        return answer({
          questions: ["How does recovery work?", "How do external effects avoid duplication?"],
        });
      if (role === "Research worker") {
        if (request.step === 1)
          return {
            type: "tool_calls",
            calls: sources.map((source) => ({
              id: source.id,
              name: "readSource",
              input: {id: source.id},
            })),
          };
        assert.equal(request.messages.filter((message) => message.role === "tool").length, 2);
        return answer({
          answer: "Replay preserves completed results; external mutations need idempotency.",
          sourceIds: sources.map((source) => source.id),
        });
      }
      assert.match(JSON.stringify(request.messages), /external mutations need idempotency/);
      return {
        type: "final",
        text: "Recovery uses replay [durability]; external effects use idempotency keys [idempotency].",
      };
    },
    {name: `fixture:${role}`},
  );
};

const reviewCounts = new Map<string, number>();
const reviewModel: Model = function* (request) {
  const message = request.messages.find((message) => message.role === "user");
  assert.ok(message && message.role === "user");
  const input = JSON.parse(message.content) as {
    task: string;
    previousCode?: string;
    feedback?: string;
    code?: string;
  };
  return yield* r.run(
    async () => {
      if (request.instructions?.startsWith("Code writer")) {
        if (input.previousCode) {
          assert.match(input.feedback!, /empty input/);
          return answer({code: "return items.length ? items[0] : undefined;"});
        }
        return answer({code: "return items[0].value;"});
      }
      reviewCounts.set(input.task, (reviewCounts.get(input.task) ?? 0) + 1);
      return answer({
        approved: input.task !== "always reject" && input.code!.includes("items.length"),
        feedback: "Handle empty input.",
      });
    },
    {name: "fixture:code"},
  );
};

function prompt(request: Parameters<Model>[0]) {
  const message = request.messages.find((message) => message.role === "user");
  assert.ok(message && message.role === "user");
  return message.content;
}
const racingModels = {
  *quick(request) {
    const input = prompt(request);
    if (input === "fallback" || input === "both fail")
      throw new TerminalError("Quick model failed");
    if (input === "stopped quick")
      return {
        type: "tool_calls",
        calls: [{id: `unknown-${request.step}`, name: "unknown", input: {}}],
      };
    yield* r.sleep(20);
    return {type: "final", text: "Quick answer"};
  },
  *thorough(request) {
    const input = prompt(request);
    if (input === "both fail") throw new TerminalError("Thorough model failed");
    if (input === "fallback" || input === "stopped quick") {
      yield* r.sleep(10);
      return {type: "final", text: "Thorough answer"};
    }
    const invocationId = r.handlerRequest().id;
    try {
      yield* r.sleep(60000);
      return {type: "final", text: "Should have been cancelled"};
    } finally {
      yield* r.run(
        async () => {
          cleanedRaces.add(invocationId);
          return null;
        },
        {name: "record-race-cleanup"},
      );
    }
  },
} satisfies Record<string, Model>;

const regularEffects = new Map<string, number>();
const regularModel = journaledModel(async (request): Promise<ModelResponse> => {
  const turns = request.messages.filter((message) => message.role === "user");
  const input = turns.at(-1)!.content;
  const callId = `${input}:${turns.length}:${request.step}`;
  regularEffects.set(callId, (regularEffects.get(callId) ?? 0) + 1);
  if (input === "fail") throw new TerminalError("Expected model failure");
  if (request.step === 1 || input === "stop") {
    return {
      type: "tool_calls",
      calls: [
        {id: `${callId}:ticket`, name: "lookupTicket", input: {ticketId: "T-42"}},
        {id: `${callId}:policy`, name: "refundPolicy", input: {}},
      ],
    };
  }
  const results = request.messages.slice(-2);
  assert.deepEqual(
    results.map((message) => {
      assert.equal(message.role, "tool");
      return message.result;
    }),
    [
      {status: "success", output: {ticketId: "T-42", status: "open"}},
      {status: "success", output: {refundWindowDays: 30, requiresReceipt: true}},
    ],
  );
  return {type: "final", text: `Answered ${input}; previous turns: ${turns.length - 1}`};
});

const tutorialModel = journaledModel(async (request): Promise<ModelResponse> => {
  if (request.tools.length > 0) {
    if (request.step === 1)
      return {
        type: "tool_calls",
        calls: [{id: "ticket", name: "lookupTicket", input: {ticketId: "T-42"}}],
      };
    const result = request.messages.at(-1);
    assert.equal(result?.role, "tool");
    assert.deepEqual(result.result, {
      status: "success",
      output: {ticketId: "T-42", status: "open"},
    });
    return {type: "final", text: "Ticket T-42 is open."};
  }
  if (request.outputSchema)
    return answer({category: "billing", summary: "Duplicate subscription charge."});
  const turns = request.messages.filter((message) => message.role === "user");
  return {type: "final", text: turns.map((message) => message.content).join(" | ")};
});

const fixtureModel: Model = function* (request) {
  const instructions = request.instructions ?? "";
  if (instructions.startsWith("Help with the user's task.")) {
    const turns = request.messages.filter((message) => message.role === "user");
    if (turns.at(-1)!.content === "interrupt") {
      r.invocation(r.handlerRequest().id).signal("interrupt").resolve("User cancelled");
      yield* r.sleep(60000);
    }
    return {type: "final", text: `Session answer; previous turns: ${turns.length - 1}`};
  }
  const last = request.messages.at(-1);
  if (last?.role === "user" && last.content.startsWith("The run stopped:"))
    return {type: "final", text: "Stopped as requested."};
  if (instructions.startsWith("Research ")) return yield* researchModel(request);
  if (instructions.startsWith("Code ")) return yield* reviewModel(request);
  if (instructions.startsWith("Quick answer.")) return yield* racingModels.quick(request);
  if (instructions.startsWith("Thorough answer.")) return yield* racingModels.thorough(request);
  if (instructions.startsWith("Help the user with their support ticket."))
    return yield* regularModel(request);
  if (
    instructions === "" ||
    instructions.startsWith("Use lookupTicket") ||
    instructions.startsWith("Use the conversation") ||
    instructions.startsWith("Classify the support request")
  )
    return yield* tutorialModel(request);
  throw new Error(`Unexpected example instructions: ${instructions}`);
};

// Replace only the external model. Import the same service instances the app serves.
mock.module("@restate-agents/core/openai", {
  namedExports: {openAIModel: () => fixtureModel},
});
const [
  {hello},
  {ticketLookup},
  {chatSession},
  {ticketTriage},
  {promiseHello},
  {promiseTicketLookup},
  {promiseChatSession},
  {promiseTicketTriage},
  {researchReport, researchWorker},
  {codeReview},
  {racingAgents},
  {regularSdkSupport, supportPolicies},
  {promiseCodeReview},
  {aiSession},
] = await Promise.all([
  import("@restate-agents/examples/gensdk/hello"),
  import("@restate-agents/examples/gensdk/tools"),
  import("@restate-agents/examples/gensdk/conversation"),
  import("@restate-agents/examples/gensdk/structured-output"),
  import("@restate-agents/examples/promise/hello"),
  import("@restate-agents/examples/promise/tools"),
  import("@restate-agents/examples/promise/conversation"),
  import("@restate-agents/examples/promise/structured-output"),
  import("@restate-agents/examples/gensdk/research-report"),
  import("@restate-agents/examples/gensdk/evaluator-optimizer"),
  import("@restate-agents/examples/gensdk/racing-agents"),
  import("@restate-agents/examples/promise/regular-sdk"),
  import("@restate-agents/examples/promise/evaluator-optimizer"),
  import("@restate-agents/examples/gensdk/session"),
]);

let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [
        hello,
        ticketLookup,
        chatSession,
        ticketTriage,
        promiseHello,
        promiseTicketLookup,
        promiseChatSession,
        promiseTicketTriage,
        barrier,
        researchReport,
        researchWorker,
        codeReview,
        racingAgents,
        regularSdkSupport,
        supportPolicies,
        promiseCodeReview,
        aiSession,
      ],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});

const tutorialExamples = [
  {
    name: "gensdk",
    hello: () => connect({url: env.baseUrl()}).client(hello),
    tools: () => connect({url: env.baseUrl()}).client(ticketLookup),
    conversation: (key: string) => connect({url: env.baseUrl()}).client(chatSession, key),
    structuredOutput: () => connect({url: env.baseUrl()}).client(ticketTriage),
  },
  {
    name: "promise",
    hello: () => connect({url: env.baseUrl()}).serviceClient(promiseHello),
    tools: () => connect({url: env.baseUrl()}).serviceClient(promiseTicketLookup),
    conversation: (key: string) =>
      connect({url: env.baseUrl()}).objectClient(promiseChatSession, key),
    structuredOutput: () => connect({url: env.baseUrl()}).serviceClient(promiseTicketTriage),
  },
];
for (const tutorial of tutorialExamples) {
  void test(`${tutorial.name} 01: each request starts a fresh run`, async () => {
    const first = await tutorial.hello().ask("Hello");
    assert.equal(first, "Hello");
    const second = await tutorial.hello().ask("Another request");
    assert.equal(second, "Another request");
  });

  void test(`${tutorial.name} 02: the model receives the executed tool's result`, async () => {
    const result = await tutorial.tools().ask("Look up ticket T-42");
    assert.equal(result, "Ticket T-42 is open.");
  });

  void test(`${tutorial.name} 03: history persists between turns and is isolated by key`, async () => {
    const first = await tutorial.conversation("bob").ask("My name is Bob.");
    assert.equal(first, "My name is Bob.");
    const second = await tutorial.conversation("bob").ask("What is my name?");
    assert.equal(second, "My name is Bob. | What is my name?");
    const other = await tutorial.conversation("alice").ask("What is my name?");
    assert.equal(other, "What is my name?");
  });

  void test(`${tutorial.name} 04: structured output reaches the caller as an object`, async () => {
    const result = await tutorial.structuredOutput().classify("I was charged twice.");
    assert.deepEqual(result, {
      category: "billing",
      summary: "Duplicate subscription charge.",
    });
  });
}

void test("support session returns only its reply while retaining conversation history", async () => {
  const client = connect({url: env.baseUrl()}).client(aiSession, "replies");
  const first = await client.doTurn({message: "Hello"});
  assert.equal(first, "Session answer; previous turns: 0");
  const second = await client.doTurn({message: "Another question"});
  assert.equal(second, "Session answer; previous turns: 1");
  const history = await client.history();
  assert.deepEqual(history.messages, [
    {role: "user", content: "Hello"},
    {role: "assistant", content: first},
    {role: "user", content: "Another question"},
    {role: "assistant", content: second},
  ]);
});

void test("interrupted support session returns its final summary", {timeout: 20000}, async () => {
  const client = connect({url: env.baseUrl()}).client(aiSession, "interrupted");
  assert.equal(await client.doTurn({message: "interrupt"}), "Stopped as requested.");
  assert.equal((await client.status()).active, null);
});

void test("regular SDK runs work before and after an agent with journaled and RPC tools", async () => {
  const client = connect({url: env.baseUrl()}).objectClient(regularSdkSupport, "conversation");
  const state = env.stateOf(regularSdkSupport, "conversation");
  const previous: Message[] = [
    {role: "user", content: "Earlier question"},
    {role: "assistant", content: "Earlier answer"},
  ];
  await state.setAll({messages: previous});

  const first = await client.ask({message: "first"});
  assert.equal(first, "Answered first; previous turns: 1");
  const firstMessages = (await state.get<Message[]>("messages"))!;
  assert.deepEqual(firstMessages.slice(0, previous.length), previous);
  assert.deepEqual(firstMessages.at(-1), {role: "assistant", content: first});
  assert.equal(await state.get("lastStatus"), "completed");

  const second = await client.ask({message: "second"});
  assert.equal(second, "Answered second; previous turns: 2");
  const secondMessages = (await state.get<Message[]>("messages"))!;
  assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages);
  assert.deepEqual(secondMessages.at(-1), {role: "assistant", content: second});
  assert.equal(regularEffects.size, 4);
  assert.ok([...regularEffects.values()].every((count) => count === 1));
});

void test("regular SDK saves stopped runs with their actual status", async () => {
  const client = connect({url: env.baseUrl()}).objectClient(regularSdkSupport, "stopped");
  const result = await client.ask({message: "stop"});
  assert.equal(result, "Agent stopped: max_steps");
  const state = env.stateOf(regularSdkSupport, "stopped");
  assert.equal(await state.get("lastStatus"), "stopped");
  const messages = (await state.get<Message[]>("messages"))!;
  assert.deepEqual(messages[0], {role: "user", content: "stop"});
  assert.equal(messages.filter((message) => message.role === "tool").length, 14);
});

void test("regular SDK propagates agent failure without executing the following state writes", async () => {
  const client = connect({url: env.baseUrl()}).objectClient(regularSdkSupport, "failure");
  const state = env.stateOf(regularSdkSupport, "failure");
  const previous: Message[] = [{role: "user", content: "Earlier question"}];
  await state.setAll({messages: previous, lastStatus: "completed"});
  await assert.rejects(async () => await client.ask({message: "fail"}), /Expected model failure/);
  assert.deepEqual(await state.get("messages"), previous);
  assert.equal(await state.get("lastStatus"), "completed");
});

void test(
  "research plans typed work, runs RPC workers in parallel, cites sources, and replays effects once",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()})
      .client(researchReport)
      .generate({topic: "Reliable execution", sources});
    assert.match(result, /\[durability\]/);
    assert.match(result, /\[idempotency\]/);
    assert.equal(effects.size, 6);
    assert.ok([...effects.values()].every((count) => count === 1));
  },
);

void test("research rejects duplicate source IDs before invoking a model", async () => {
  const calls = effects.size;
  await assert.rejects(
    connect({url: env.baseUrl()})
      .client(researchReport)
      .generate({topic: "Invalid catalog", sources: [sources[0], sources[0]]}),
    /Source IDs must be unique/,
  );
  assert.equal(effects.size, calls);
});

void test("a research worker cannot cite a supplied source it has not read", async () => {
  await assert.rejects(
    connect({url: env.baseUrl()})
      .client(researchWorker)
      .research({question: "cite without reading", sources}),
    /source the worker did not read/,
  );
});

const reviewExamples = [
  {name: codeReview.name, client: () => connect({url: env.baseUrl()}).client(codeReview)},
  {
    name: promiseCodeReview.name,
    client: () => connect({url: env.baseUrl()}).serviceClient(promiseCodeReview),
  },
];
for (const reviewExample of reviewExamples) {
  void test(`${reviewExample.name}: evaluator feedback reaches the next draft and stops on acceptance`, async () => {
    const task = "Read the first item safely";
    const before = reviewCounts.get(task) ?? 0;
    const result = await reviewExample.client().generate({task});
    assert.equal(result, "return items.length ? items[0] : undefined;");
    assert.equal(reviewCounts.get(task)! - before, 2);
  });

  void test(`${reviewExample.name}: exhausting the budget retains the last draft and feedback`, async () => {
    const task = "always reject";
    const before = reviewCounts.get(task) ?? 0;
    const result = await reviewExample.client().generate({task});
    assert.match(result, /still needs work after 3 reviews: Handle empty input/);
    assert.match(result, /items.length/);
    assert.equal(reviewCounts.get(task)! - before, 3);
  });
}

void test(
  "racing returns the winner only after the losing agent's cleanup",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()})
      .client(racingAgents)
      .answer({question: "cancel loser"});
    assert.equal(result, "Quick answer");
    assert.equal(cleanedRaces.size, 1);
  },
);

for (const question of ["fallback", "stopped quick"]) {
  void test(`racing waits for a completed answer after ${question}`, {timeout: 20000}, async () => {
    assert.equal(
      await connect({url: env.baseUrl()}).client(racingAgents).answer({question}),
      "Thorough answer",
    );
  });
}
void test("racing fails clearly if neither agent completes", async () => {
  await assert.rejects(
    connect({url: env.baseUrl()}).client(racingAgents).answer({question: "both fail"}),
    /Neither candidate produced a completed answer/,
  );
});
