import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  GuardrailError,
  handoff,
  LazyStateConversation,
  tool,
  type ConversationStore,
  type ModelResponse,
} from "@restate-agents/core";

const context = () =>
  ({
    request: () => ({id: "review", attemptCompletedSignal: new AbortController().signal}),
  }) as unknown as Context;
const final: ModelResponse = {type: "final", text: "accepted answer"};
const toolCall: ModelResponse = {
  type: "tool_calls",
  calls: [{id: "write", name: "write", input: {}}],
};

function conversation() {
  const values = new Map<string, unknown>();
  const store: ConversationStore = {
    *get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    *set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  return new LazyStateConversation({store});
}

void test("steering rejects stale tool plans before they can cause effects", async () => {
  let writes = 0;
  await r.execute(
    context(),
    (function* () {
      const changed = r.channel<string>();
      const never = r.channel<string>();
      let listens = 0;
      const a = agent({
        tools: {
          write: tool({
            description: "write",
            input: z.object({}),
            *execute() {
              writes++;
              return "written";
            },
          }),
        },
        *model(request) {
          if (request.step === 1) {
            yield* changed.send("Do not write; just explain the plan");
            return toolCall;
          }
          assert.match(JSON.stringify(request.messages), /Do not write/);
          return final;
        },
      });
      const result = yield* a.run("write", {
        controls: {steering: () => (listens++ === 0 ? changed.receive : never.receive)},
      });
      assert.equal(result.status, "completed");
      assert.equal(
        result.messages.some((message) => message.role === "tool"),
        false,
      );
    })(),
  );
  assert.equal(writes, 0);
});

void test("interruption during an output guard never persists the unaccepted candidate", async () => {
  await r.execute(
    context(),
    (function* () {
      const stop = r.channel<string>();
      const convo = conversation();
      const a = agent({
        *model() {
          return {type: "final", text: "unapproved secret"};
        },
        *afterRun(result) {
          if (result.status === "completed") {
            yield* stop.send("stop before publication");
            yield* r.channel().receive;
          }
          return result;
        },
      });
      const result = yield* a.run("go", {conversation: convo, controls: {interrupt: stop.receive}});
      assert.equal(result.status, "interrupted");
      assert.doesNotMatch(JSON.stringify(result.messages), /unapproved secret/);
      assert.doesNotMatch(JSON.stringify(yield* convo.load()), /unapproved secret/);
    })(),
  );
});

void test("an output policy's stopped summary is included in persisted history", async () => {
  await r.execute(
    context(),
    (function* () {
      const convo = conversation();
      const a = agent({
        maxSteps: 1,
        *model() {
          return toolCall;
        },
        *afterRun(result) {
          return result.status === "stopped"
            ? {...result, output: "No write was performed"}
            : result;
        },
      });
      const result = yield* a.run("go", {conversation: convo});
      assert.equal(result.status, "stopped");
      assert.deepEqual(result.messages.at(-1), {
        role: "assistant",
        content: "No write was performed",
      });
      assert.deepEqual((yield* convo.load()).messages, result.messages);
    })(),
  );
});

void test("output policies cannot convert an exhausted run into completed success", async () => {
  const a = agent({
    maxSteps: 1,
    *model() {
      return toolCall;
    },
    *afterRun(result) {
      return {...result, status: "completed", output: "fake success"};
    },
  });
  await assert.rejects(r.execute(context(), a.run("go")), GuardrailError);
});

void test("root step policies still apply after transferring to a specialist", async () => {
  let specialistCalled = false;
  const specialist = agent({
    *model() {
      specialistCalled = true;
      return final;
    },
  });
  const a = agent({
    tools: {transfer: handoff(specialist)},
    *model() {
      return {type: "tool_calls", calls: [{id: "handoff", name: "transfer", input: {}}]};
    },
    *beforeStep(request) {
      return request.step === 1 || "Further inference is denied";
    },
  });
  await assert.rejects(r.execute(context(), a.run("go")), GuardrailError);
  assert.equal(specialistCalled, false);
});

void test("output hooks cannot mutate the runtime's history through their candidate", async () => {
  const a = agent({
    *model() {
      return final;
    },
    *afterRun(result) {
      result.messages.splice(0, result.messages.length, {role: "user", content: "forged"});
      return result;
    },
  });
  const result = await r.execute(context(), a.run("original"));
  assert.equal(result.messages[0]?.role, "user");
  assert.match(JSON.stringify(result.messages), /original/);
  assert.doesNotMatch(JSON.stringify(result.messages), /forged/);
});

void test("structured output rejects transforms instead of applying them twice", () => {
  assert.throws(
    () =>
      agent({
        output: z.object({count: z.number().transform((value) => value + 1)}),
        *model() {
          return {type: "final", text: '{"count":1}'};
        },
      }),
    /transform/i,
  );
});

void test("interruption after final output acceptance does not change the completed result", async () => {
  await r.execute(
    context(),
    (function* () {
      const stop = r.channel<string>();
      const a = agent({
        *model() {
          return final;
        },
        *onUpdate(event) {
          if (event.type === "run-end") yield* stop.send("late interruption");
        },
      });
      const result = yield* a.run("go", {controls: {interrupt: stop.receive}});
      assert.equal(result.status, "completed");
      assert.equal(result.output, "accepted answer");
    })(),
  );
});
