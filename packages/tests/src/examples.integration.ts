import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {TerminalError} from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import * as r from "@restatedev/restate-sdk-gen";
import {type Model, type ModelResponse} from "@restate-agents/core";
import {createResearchServices} from "@restate-agents/examples/research-report";
import {createCodeReviewService} from "@restate-agents/examples/evaluator-optimizer";
import {createRacingService} from "@restate-agents/examples/racing-agents";

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
const research = createResearchServices(researchModel);

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
        if (input.previousCode) assert.match(input.feedback!, /empty input/);
        return answer({
          code: input.previousCode
            ? "return items.length ? items[0] : undefined;"
            : "return items[0].value;",
        });
      }
      return answer({
        approved: input.task !== "always reject" && input.code!.includes("items.length"),
        feedback: "Handle empty input.",
      });
    },
    {name: "fixture:code"},
  );
};
const codeReview = createCodeReviewService(reviewModel);

function prompt(request: Parameters<Model>[0]) {
  const message = request.messages.find((message) => message.role === "user");
  assert.ok(message && message.role === "user");
  return message.content;
}
const racing = createRacingService({
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
});

let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [barrier, research.researchReport, research.researchWorker, codeReview, racing],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});

void test(
  "research plans typed work, runs RPC workers in parallel, cites sources, and replays effects once",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()})
      .client(research.researchReport)
      .generate({topic: "Reliable execution", sources});
    assert.equal(result.taskCount, 2);
    assert.equal(result.findings.length, 2);
    assert.match(result.report, /\[durability\]/);
    assert.equal(effects.size, 6);
    assert.ok([...effects.values()].every((count) => count === 1));
  },
);

void test("research rejects duplicate source IDs before invoking a model", async () => {
  const calls = effects.size;
  await assert.rejects(
    connect({url: env.baseUrl()})
      .client(research.researchReport)
      .generate({topic: "Invalid catalog", sources: [sources[0], sources[0]]}),
    /Source IDs must be unique/,
  );
  assert.equal(effects.size, calls);
});

void test("a research worker cannot cite a supplied source it has not read", async () => {
  await assert.rejects(
    connect({url: env.baseUrl()})
      .client(research.researchWorker)
      .research({question: "cite without reading", sources}),
    /source the worker did not read/,
  );
});

void test("evaluator feedback reaches the next draft and the loop stops on acceptance", async () => {
  const result = await connect({url: env.baseUrl()})
    .client(codeReview)
    .generate({task: "Read the first item safely"});
  assert.equal(result.status, "accepted");
  assert.equal(result.iterations, 2);
  assert.deepEqual(
    result.reviews.map((review) => review.approved),
    [false, true],
  );
  assert.match(result.code, /items.length/);
});

void test("exhausting the evaluator budget retains the last draft and review feedback", async () => {
  const result = await connect({url: env.baseUrl()})
    .client(codeReview)
    .generate({task: "always reject"});
  assert.equal(result.status, "exhausted");
  assert.equal(result.iterations, 3);
  assert.equal(result.reviews.length, 3);
  assert.match(result.code, /items.length/);
});

void test(
  "racing returns the winner only after the losing agent's cleanup",
  {timeout: 20000},
  async () => {
    const result = await connect({url: env.baseUrl()})
      .client(racing)
      .answer({question: "cancel loser"});
    assert.deepEqual(result, {winner: "quick", answer: "Quick answer"});
    assert.equal(cleanedRaces.size, 1);
  },
);

for (const question of ["fallback", "stopped quick"]) {
  void test(`racing waits for a completed answer after ${question}`, {timeout: 20000}, async () => {
    assert.deepEqual(await connect({url: env.baseUrl()}).client(racing).answer({question}), {
      winner: "thorough",
      answer: "Thorough answer",
    });
  });
}
void test("racing fails clearly if neither agent completes", async () => {
  await assert.rejects(
    connect({url: env.baseUrl()}).client(racing).answer({question: "both fail"}),
    /Neither candidate produced a completed answer/,
  );
});
