import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  ConversationConflictError,
  GuardrailError,
  LazyStateConversation,
  type Message,
  type Model,
} from "@restatedev/agentlib";
import {z} from "zod";
import {history} from "../../core/src/validation.js";
import {runHandler} from "./replay-harness.mjs";
import {testContext, memoryStore} from "./helpers.js";
const context = () => testContext("conversation");
const pairs = (n: number): Message[] =>
  Array.from({length: n}, (_, i) => [
    {role: "user" as const, content: `question ${i}`},
    {role: "assistant" as const, content: `answer ${i}`},
  ]).flat();

void test("output policies replace the answer in persisted and returned conversation history", async () => {
  const convo = new LazyStateConversation({store: memoryStore().store});
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

void test("a rejected structured answer reaches the retry but is never persisted or returned", async () => {
  const convo = new LazyStateConversation({store: memoryStore().store});
  let requests = 0;
  const a = agent({
    output: z.object({answer: z.string()}),
    *model(request) {
      requests++;
      if (requests === 1) return {type: "final", text: "not json"};
      assert.match(JSON.stringify(request.messages), /not json/);
      assert.match(JSON.stringify(request.messages), /output-invalid/);
      return {type: "final", text: JSON.stringify({answer: "ok"})};
    },
  });
  await r.execute(
    context(),
    (function* () {
      const result = yield* a.run("go", {conversation: convo});
      assert.deepEqual(result.output, {answer: "ok"});
      assert.equal(requests, 2);
      assert.doesNotMatch(JSON.stringify(result.messages), /not json|output-invalid/);
      const saved = yield* convo.load();
      assert.deepEqual(saved.messages, result.messages);
    })(),
  );
});

void test("a conversation lazily persists chunks and supplies history across embedded runs", async () => {
  const {store, values} = memoryStore();
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
  const {store} = memoryStore();
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
      // Desired cut falls between a call and its result; move it back to the
      // user message that asked for the call.
      const plan = yield* convo.prepareCompaction({maxMessages: 8, retainMessages: 5});
      assert.ok(plan);
      assert.equal(plan.through, 4);
      history(plan.messages);
      assert.equal(
        yield* convo.applyCompaction({plan, summary: "earlier goals and results"}),
        true,
      );
      const snapshot = yield* convo.load();
      assert.equal(snapshot.messages.length, 9);
      assert.deepEqual(snapshot.messages[1], {role: "user", content: "question 2"});
      history(snapshot.messages);
      assert.match(JSON.stringify(snapshot.messages[0]), /earlier goals/);
      assert.deepEqual((yield* convo.page()).messages, messages);
    })(),
  );
});

void test("the retained tail starts at a user message", async () => {
  const {store} = memoryStore();
  const convo = new LazyStateConversation({store});
  await r.execute(
    context(),
    (function* () {
      yield* convo.append(pairs(6), 0);
      // Retaining 3 would start the tail at "answer 4"; keep its question too.
      const plan = yield* convo.prepareCompaction({maxMessages: 8, retainMessages: 3});
      assert.ok(plan);
      assert.equal(plan.through, 8);
      assert.deepEqual(plan.messages.at(-1), {role: "assistant", content: "answer 3"});
    })(),
  );
});

void test("a summary without text fails compaction terminally and keeps history", async () => {
  const {store} = memoryStore();
  const convo = new LazyStateConversation({
    store,
    compaction: {
      *model() {
        return {type: "final", text: " ", output: {summary: "structured"}};
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
        assert.ok(error instanceof TerminalError);
        assert.match(String(error), /empty summary/);
      }
      assert.deepEqual((yield* convo.load()).messages, pairs(4));
    })(),
  );
});

void test("compaction tolerates concurrent appends but refuses an overlapping stale summary", async () => {
  const {store} = memoryStore();
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
        const {store} = memoryStore();
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
  const {store} = memoryStore();
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
  const {store} = memoryStore();
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
  await assert.rejects(r.execute(context(), a.run("go", {conversation: convo})), GuardrailError);
  assert.equal(summarized, false);
});
