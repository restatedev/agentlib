import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  GuardrailError,
  handoff,
  LazyStateConversation,
  ModelProtocolError,
  tool,
  type ModelResponse,
} from "@restatedev/agentlib";
import {testContext, memoryStore} from "./helpers.js";

const context = () => testContext("review");
const final: ModelResponse = {type: "final", text: "accepted answer"};
const toolCall: ModelResponse = {
  type: "tool_calls",
  calls: [{id: "write", name: "write", input: {}}],
};

function conversation() {
  return new LazyStateConversation({store: memoryStore().store});
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
        finalize: false,
        *model() {
          return {type: "final", text: "unapproved secret"};
        },
        *afterRun(result) {
          if (result.status === "completed") {
            yield* stop.send("stop before publication");
            yield* r.channel().receive;
          }
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
          if (result.status === "stopped") return {output: "No write was performed"};
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
  const a = agent<undefined>({
    maxSteps: 1,
    *model() {
      return toolCall;
    },
    // @ts-expect-error JavaScript callers are also checked for forbidden lifecycle edits.
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

void test("a batch with two handoffs fails before any of its calls run", async () => {
  let writes = 0;
  const specialist = agent({
    *model() {
      return final;
    },
  });
  const a = agent({
    tools: {
      first: handoff(specialist),
      second: handoff(specialist),
      write: tool({
        description: "write",
        input: z.object({}),
        *execute() {
          writes++;
          return "ok";
        },
      }),
    },
    *model() {
      return {
        type: "tool_calls",
        calls: [
          {id: "write", name: "write", input: {}},
          {id: "a", name: "first", input: {}},
          {id: "b", name: "second", input: {}},
        ],
      };
    },
  });
  await assert.rejects(r.execute(context(), a.run("go")), ModelProtocolError);
  assert.equal(writes, 0);
});

void test("a handoff batched with other calls runs them, then transfers", async () => {
  let writes = 0;
  const specialist = agent({
    *model(request) {
      // The specialist sees the batch's results.
      assert.match(JSON.stringify(request.messages), /"written"/);
      return {type: "final", text: "specialist answer"};
    },
  });
  let steps = 0;
  const a = agent({
    tools: {
      transfer: handoff(specialist),
      write: tool({
        description: "write",
        input: z.object({}),
        *execute() {
          writes++;
          return "written";
        },
      }),
    },
    *model() {
      steps++;
      return {
        type: "tool_calls",
        calls: [
          {id: "write", name: "write", input: {}},
          {id: "handoff", name: "transfer", input: {}},
        ],
      };
    },
  });
  const result = await r.execute(context(), a.run("go"));
  assert.equal(result.status, "completed");
  assert.equal(result.output, "specialist answer");
  assert.equal(writes, 1);
  assert.equal(steps, 1);
});

void test("output hooks cannot mutate the runtime's history through their candidate", async () => {
  const a = agent({
    *model() {
      return final;
    },
    *afterRun(result) {
      // @ts-expect-error Runtime isolation also protects against untyped candidate mutation.
      result.messages.splice(0, result.messages.length, {role: "user", content: "forged"});
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
