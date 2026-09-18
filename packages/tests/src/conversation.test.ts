import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  ConversationConflictError,
  LazyStateConversation,
  type ConversationStore,
  type Message,
  type Model,
} from "@restate-agents/core";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
const context = () =>
  ({
    request: () => ({id: "conversation", attemptCompletedSignal: new AbortController().signal}),
  }) as unknown as Context;
function memory() {
  const values = new Map<string, unknown>();
  const store: ConversationStore = {
    *get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    *set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  return {store, values};
}
const pairs = (n: number): Message[] =>
  Array.from({length: n}, (_, i) => [
    {role: "user" as const, content: `question ${i}`},
    {role: "assistant" as const, content: `answer ${i}`},
  ]).flat();

void test("output policies replace the answer in persisted and returned conversation history", async () => {
  const convo = new LazyStateConversation({store: memory().store});
  const a = agent({
    *model() {
      return {type: "final", text: "private candidate"};
    },
    *afterRun(result) {
      if (result.status === "completed") return {output: "public answer"};
    },
  });
  await r.execute(
    context(),
    (function* () {
      const result = yield* a.run("go", {conversation: convo});
      assert.equal(result.output, "public answer");
      assert.doesNotMatch(JSON.stringify(result.messages), /private candidate/);
      const saved = yield* convo.load();
      assert.deepEqual(saved.messages, result.messages);
      assert.deepEqual(saved.messages.at(-1), {role: "assistant", content: "public answer"});
    })(),
  );
});

void test("a conversation lazily persists chunks and supplies history across embedded runs", async () => {
  const {store, values} = memory();
  const convo = new LazyStateConversation({store, metaKey: "meta", stateKey: "convo"});
  assert.equal(values.size, 0);
  await r.execute(
    context(),
    (function* () {
      const version = yield* convo.append(pairs(20), 0);
      assert.equal(version, 40);
      let checked = false;
      const a = agent({
        *model(req) {
          assert.equal(req.messages.length, 41);
          checked = true;
          return {type: "final", text: "next answer"};
        },
      });
      const result = yield* a.run("next", {conversation: convo});
      assert.equal(checked, true);
      assert.equal(result.messages.length, 42);
      const page = yield* convo.page(30, 5);
      assert.equal(page.messages.length, 5);
      assert.equal(page.next, 35);
      const snapshot = yield* convo.load();
      assert.equal(snapshot.version, 42);
      history(snapshot.messages);
    })(),
  );
  assert.equal((values.get("convo/0") as Message[]).length, 32);
  assert.equal((values.get("convo/1") as Message[]).length, 10);
});

void test("compaction retains complete tool exchanges and leaves the original log available", async () => {
  const {store} = memory();
  const convo = new LazyStateConversation({store});
  await r.execute(
    context(),
    (function* () {
      const messages: Message[] = [
        ...pairs(3),
        {role: "assistant", content: "", calls: [{id: "a", name: "lookup", input: {}}]},
        {role: "tool", callId: "a", name: "lookup", result: {status: "success", output: 1}},
        ...pairs(2),
      ];
      yield* convo.append(messages, 0);
      // Desired cut falls between a call and its result; move it before the call.
      const plan = yield* convo.prepareCompaction({maxMessages: 8, retainMessages: 5});
      assert.ok(plan);
      assert.equal(plan.through, 6);
      history(plan.messages);
      assert.equal(
        yield* convo.applyCompaction({plan, summary: "earlier goals and results"}),
        true,
      );
      const snapshot = yield* convo.load();
      assert.equal(snapshot.messages.length, 7);
      history(snapshot.messages);
      assert.match(JSON.stringify(snapshot.messages[0]), /earlier goals/);
      assert.deepEqual((yield* convo.page()).messages, messages);
    })(),
  );
});

void test("compaction tolerates concurrent appends but refuses an overlapping stale summary", async () => {
  const {store} = memory();
  const convo = new LazyStateConversation({store});
  await r.execute(
    context(),
    (function* () {
      yield* convo.append(pairs(10), 0);
      const old = yield* convo.prepareCompaction({maxMessages: 8, retainMessages: 4});
      assert.ok(old);
      yield* convo.append(
        [
          {role: "user", content: "new steering"},
          {role: "assistant", content: "new answer"},
        ],
        20,
      );
      assert.equal(yield* convo.applyCompaction({plan: old, summary: "first summary"}), true);
      const loaded = yield* convo.load();
      assert.equal(loaded.version, 22);
      assert.match(JSON.stringify(loaded.messages), /new steering/);
      assert.equal(yield* convo.applyCompaction({plan: old, summary: "stale summary"}), false);
      assert.equal(yield* convo.applyCompaction({plan: old, summary: "first summary"}), true);
      try {
        yield* convo.append(pairs(1), 20);
        assert.fail("stale writer accepted");
      } catch (e) {
        assert.ok(e instanceof ConversationConflictError);
      }
    })(),
  );
});

void test("automatic model compaction and conversation writes are replayable", async () => {
  let summaries = 0;
  const initial = pairs(10);
  const summarize: Model = function* (request) {
    assert.deepEqual(request.tools, []);
    assert.match(request.instructions!, /unresolved/);
    return yield* r.run(
      async () => {
        summaries++;
        return {type: "final" as const, text: "user goals; unfinished task remains"};
      },
      {name: "summarize"},
    );
  };
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const {store} = memory();
        const convo = new LazyStateConversation({
          store,
          compaction: {model: summarize, policy: {maxMessages: 8, retainMessages: 4}},
        });
        yield* convo.append(initial, 0);
        const a = agent({
          *model(request) {
            assert.equal(request.messages.length, 6);
            assert.match(JSON.stringify(request.messages[0]), /unfinished task/);
            return {type: "final", text: "done"};
          },
        });
        const result = yield* a.run("continue", {conversation: convo});
        return {result, history: yield* convo.page()};
      })(),
    );
  const first = await runHandler(handler);
  assert.equal(summaries, 1);
  assert.equal(first.output.history.messages.length, 22);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(summaries, 1);
});

void test("a failed compactor never removes history or installs a partial checkpoint", async () => {
  const {store} = memory();
  const convo = new LazyStateConversation({
    store,
    compaction: {
      model: function* () {
        throw new Error("summarizer failed");
      },
      policy: {maxMessages: 4, retainMessages: 2},
    },
  });
  await r.execute(
    context(),
    (function* () {
      yield* convo.append(pairs(4), 0);
      try {
        yield* convo.compact();
        assert.fail("must fail");
      } catch (error) {
        assert.match(String(error), /summarizer failed/);
      }
      assert.deepEqual((yield* convo.load()).messages, pairs(4));
    })(),
  );
});

void test("beforeRun rejection precedes all model work, including automatic compaction", async () => {
  let summarized = false;
  const {store} = memory();
  const convo = new LazyStateConversation({
    store,
    compaction: {
      model: function* () {
        summarized = true;
        return {type: "final", text: "summary"};
      },
      policy: {maxMessages: 2, retainMessages: 1},
    },
  });
  await r.execute(
    context(),
    (function* () {
      yield* convo.append(pairs(3), 0);
    })(),
  );
  const a = agent({
    *beforeRun() {
      return false;
    },
    *model() {
      assert.fail("blocked model");
    },
  });
  await assert.rejects(r.execute(context(), a.run("go", {conversation: convo})));
  assert.equal(summarized, false);
});
