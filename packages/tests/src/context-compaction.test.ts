import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  tool,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ProgressEvent,
} from "@restate-agents/core";
import {z} from "zod";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";

const context = () => testContext("context-compaction");
const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "x".repeat(400);
  },
});
const reads = (id: string) => ({
  type: "tool_calls" as const,
  calls: [{id, name: "read", input: {}}],
});
// About three reads outgrow maxTokens; the newest read fits retainTokens.
const compaction = {maxTokens: 650, retainTokens: 300};

function note(messages: readonly Message[]): Record<string, unknown> | undefined {
  const first = messages[0];
  if (first?.role !== "user") return undefined;
  const parsed = JSON.parse(first.content.startsWith("{") ? first.content : "null");
  return parsed?.type === "context-compacted" ? parsed : undefined;
}

void test("a long run compacts its view but saves every message", async () => {
  const requests: ModelRequest[] = [];
  const compactorInputs: Record<string, unknown>[] = [];
  const events: ProgressEvent[] = [];
  const a = agent({
    tools: {read},
    *model(request) {
      requests.push(structuredClone(request));
      // Every view must be a valid model transcript: no result without its call.
      history(request.messages);
      const step = requests.length;
      return step <= 5 ? reads(`r${step}`) : {type: "final", text: "Done"};
    },
    compaction: {
      ...compaction,
      *model(request) {
        assert.deepEqual(request.tools, []);
        compactorInputs.push(JSON.parse((request.messages[0] as {content: string}).content));
        return {type: "final", text: `read ${compactorInputs.length} batch of pages`};
      },
    },
  });
  const result = await r.execute(
    context(),
    a.run("Go", {
      *onProgress(event) {
        events.push(event);
      },
    }),
  );
  assert.equal(result.status, "completed");
  // The returned transcript keeps the input and every tool result.
  assert.deepEqual(result.messages[0], {role: "user", content: "Go"});
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 5);

  const compacted = requests.filter((request) => note(request.messages));
  assert.ok(compacted.length > 0);
  for (const request of compacted) {
    assert.equal(note(request.messages)!.request, "Go");
    assert.equal(
      request.messages.some((m) => m.role === "user" && m.content === "Go"),
      false,
    );
  }
  assert.deepEqual(
    events.filter((event) => event.type === "compaction"),
    compactorInputs.map(() => ({
      type: "compaction",
      mode: "summary",
      status: "applied",
      reason: "threshold",
    })),
  );
  assert.equal(compactorInputs[0]!.previousNote, null);
  // A later compaction folds the earlier note into the new one.
  assert.ok(compactorInputs.length >= 2);
  assert.match(String(compactorInputs[1]!.previousNote), /read 1 batch/);
});

void test("the cut keeps a batch's results with its call", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    tools: {read},
    *model(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) return reads("r1");
      if (requests.length === 2)
        return {
          type: "tool_calls",
          calls: ["a", "b", "c"].map((id) => ({id, name: "read", input: {}})),
        };
      return {type: "final", text: "Done"};
    },
    // The three-call batch alone is larger than retainTokens.
    compaction: {
      ...compaction,
      *model() {
        return {type: "final", text: "note"};
      },
    },
  });
  const result = await r.execute(context(), a.run("Go"));
  assert.equal(result.status, "completed");
  const last = requests.at(-1)!.messages;
  assert.ok(note(last));
  // The batch did not fit, so nothing of it stays: no result lost its call.
  history(last);
  assert.equal(last.length, 1);
});

void test("a failed summary falls back to truncation and is not retried", async () => {
  let attempts = 0;
  const events: ProgressEvent[] = [];
  const views: Message[][] = [];
  const a = agent({
    tools: {read},
    model: (() => {
      let step = 0;
      return function* (request: ModelRequest) {
        views.push(structuredClone(request.messages));
        history(request.messages);
        return ++step <= 7 ? reads(`r${step}`) : {type: "final", text: "Done"};
      };
    })(),
    compaction: {
      ...compaction,
      *model() {
        attempts++;
        throw new Error("compactor down");
      },
    },
  });
  const result = await r.execute(
    context(),
    a.run("Go", {
      *onProgress(event) {
        events.push(event);
      },
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(attempts, 1);
  const [failed, ...rest] = events.filter((event) => event.type === "compaction");
  assert.equal(failed?.type === "compaction" && failed.status, "failed");
  assert.match(String(failed?.type === "compaction" && failed.error), /compactor down/);
  // Every later compaction truncates without asking the compactor.
  assert.ok(rest.length >= 2);
  for (const event of rest)
    assert.deepEqual(event, {
      type: "compaction",
      mode: "truncate",
      status: "applied",
      reason: "threshold",
    });
  const truncated = JSON.parse((views.at(-1)![0] as {content: string}).content);
  assert.equal(truncated.type, "context-truncated");
  assert.equal(truncated.request, "Go");
  assert.equal(truncated.handoff, undefined);
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 7);
});

void test("a stopped run finalizes from the compacted view", async () => {
  let finalized: readonly Message[] = [];
  let step = 0;
  const a = agent({
    tools: {read},
    maxSteps: 4,
    *model() {
      return reads(`r${++step}`);
    },
    *finalize(request) {
      finalized = request.messages;
      return {type: "final", text: "Stopped after reading"};
    },
    compaction: {
      ...compaction,
      *model() {
        return {type: "final", text: "note"};
      },
    },
  });
  const result = await r.execute(context(), a.run("Go"));
  assert.equal(result.status, "stopped");
  assert.equal(result.output, "Stopped after reading");
  assert.ok(note(finalized));
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 4);
});

void test("the handoff note names background calls that are still running", async () => {
  let handoff: Record<string, unknown> | undefined;
  await r.execute(
    context(),
    (function* () {
      const release = r.channel<void>();
      let step = 0;
      const a = agent({
        tools: {
          read,
          watch: tool({
            description: "Watch a job",
            input: z.object({}),
            background: true,
            *execute() {
              yield* release.receive;
              return "finished";
            },
          }),
        },
        *model(request) {
          handoff ??= note(request.messages);
          step++;
          if (step === 1)
            return {type: "tool_calls", calls: [{id: "w1", name: "watch", input: {}}]};
          if (step <= 5) return reads(`r${step}`);
          return {type: "final", text: "Done"};
        },
        compaction: {
          ...compaction,
          *model() {
            yield* release.send();
            return {type: "final", text: "note"};
          },
        },
      });
      return yield* a.run("Go");
    })(),
  );
  assert.deepEqual(handoff?.pending, [{operationId: "w1", name: "watch"}]);
});

void test("compaction replays from the journal without calling the compactor again", async () => {
  let compactions = 0;
  const journaled = (name: string, respond: () => ModelResponse): Model =>
    function* () {
      return yield* r.run(async () => respond(), {name});
    };
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        let step = 0;
        const a = agent({
          tools: {read},
          model: journaled("model", () =>
            ++step <= 5 ? reads(`r${step}`) : {type: "final", text: "Done"},
          ),
          compaction: {
            ...compaction,
            model: journaled("compactor", () => {
              compactions++;
              return {type: "final", text: "note"};
            }),
          },
        });
        return yield* a.run("Go");
      })(),
    );
  const first = await runHandler(handler);
  const calls = compactions;
  assert.ok(calls > 0);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(compactions, calls);
});

void test("retainTokens must be below maxTokens", () => {
  assert.throws(
    () =>
      agent({
        model: function* () {
          return {type: "final", text: ""};
        },
        compaction: {maxTokens: 100, retainTokens: 100},
      }),
    /retainTokens must be less than/,
  );
});
