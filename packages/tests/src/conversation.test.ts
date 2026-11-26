import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  AgentTerminalError,
  ConversationConflictError,
  LazyStateConversation,
  type Conversation,
  type Message,
  type Model,
  type ModelResponse,
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

void test("a stored summary replaces older messages for the next load, and page() keeps them", async () => {
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
      // Keeping five messages would start them with a result whose call is summarized.
      try {
        yield* convo.storeSummary("earlier goals and results", 5, 12);
        assert.fail("must reject a result without its call");
      } catch (error) {
        assert.match(String(error), /unmatched or duplicate tool result/);
      }
      assert.equal(yield* convo.storeSummary("earlier goals and results", 4, 12), true);
      const snapshot = yield* convo.load();
      assert.equal(snapshot.summary, "earlier goals and results");
      assert.equal(snapshot.version, 12);
      assert.deepEqual(snapshot.messages, pairs(2));
      assert.deepEqual((yield* convo.page()).messages, messages);
    })(),
  );
});

void test("a summary is stored only for the current version and a boundary that moves forward", async () => {
  const {store} = memoryStore();
  const convo = new LazyStateConversation({store});
  await r.execute(
    context(),
    (function* () {
      yield* convo.append(pairs(10), 0);
      // Another writer appended since version 18.
      assert.equal(yield* convo.storeSummary("first summary", 4, 18), false);
      assert.equal(yield* convo.storeSummary("first summary", 4, 20), true);
      // The stored summary already covers as many messages, or more.
      assert.equal(yield* convo.storeSummary("same boundary", 4, 20), false);
      assert.equal(yield* convo.storeSummary("older boundary", 6, 20), false);
      // Appends after a summary keep the version check.
      assert.equal(yield* convo.append(pairs(1), 20), 22);
      try {
        yield* convo.append(pairs(1), 20);
        assert.fail("stale writer accepted");
      } catch (error) {
        assert.ok(error instanceof ConversationConflictError);
      }
      const loaded = yield* convo.load();
      assert.equal(loaded.summary, "first summary");
      assert.deepEqual(loaded.messages, [...pairs(10).slice(16), ...pairs(1)]);
      for (const [summary, keep] of [
        [" ", 2],
        ["x".repeat(64001), 2],
        ["valid", -1],
      ] as const)
        try {
          yield* convo.storeSummary(summary, keep, 22);
          assert.fail("invalid summary accepted");
        } catch (error) {
          assert.ok(error instanceof TypeError);
        }
    })(),
  );
});

void test("a run stores its summary, the next run starts from it, and both replay", async () => {
  let summaries = 0;
  const summarize: Model = function* (request) {
    assert.deepEqual(request.tools, []);
    assert.match(request.instructions!, /later turns/);
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
        const convo = new LazyStateConversation({store});
        yield* convo.append(pairs(30), 0);
        const requests: Message[][] = [];
        // The loaded history outgrows maxTokens; after the summary, the next run fits.
        const a = agent({
          compaction: {model: summarize, maxTokens: 300, retainTokens: 30},
          *model(request) {
            requests.push([...request.messages]);
            return {type: "final", text: "done"};
          },
        });
        yield* a.run("continue", {conversation: convo});
        yield* a.run("and then?", {conversation: convo});
        return {requests, snapshot: yield* convo.load(), history: yield* convo.page()};
      })(),
    );
  const first = await runHandler(handler);
  assert.equal(summaries, 1);
  const {requests, snapshot, history: saved} = first.output;
  for (const request of requests)
    assert.match(JSON.stringify(request[0]), /context-compacted.*user goals; unfinished task/);
  assert.deepEqual(requests[1]!.slice(-3), [
    {role: "user", content: "continue"},
    {role: "assistant", content: "done"},
    {role: "user", content: "and then?"},
  ]);
  assert.equal(snapshot.summary, "user goals; unfinished task remains");
  assert.equal(saved.messages.length, 64);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(summaries, 1);
});

/** A conversation long enough that a run compacts it before its first step, with
 * an agent whose input and one note fit retainTokens. */
function* compactingConversation() {
  const convo = new LazyStateConversation({store: memoryStore().store});
  const long = (role: "user" | "assistant", i: number): Message => ({
    role,
    content: `${role} ${i} ${"x".repeat(400)}`,
  });
  yield* convo.append(
    [0, 1, 2].flatMap((i) => [long("user", i), long("assistant", i)]),
    0,
  );
  return convo;
}
const compactingWith = (onSummary: () => void) => ({
  maxTokens: 200,
  retainTokens: 80,
  *model(): r.Operation<ModelResponse> {
    onSummary();
    return {type: "final", text: "summary"};
  },
});

void test("beforeRun can stop the run before all model work, including compaction", async () => {
  let summarized = false;
  const a = agent({
    compaction: compactingWith(() => (summarized = true)),
    *beforeRun() {
      throw new AgentTerminalError("This request is out of scope");
    },
    *model() {
      assert.fail("blocked model");
    },
  });
  await assert.rejects(
    r.execute(
      context(),
      (function* () {
        const convo = yield* compactingConversation();
        return yield* a.run("go", {conversation: convo});
      })(),
    ),
    {name: "AgentTerminalError", message: "This request is out of scope"},
  );
  assert.equal(summarized, false);
});

void test("a beforeRun rejection reaches the model after compaction", async () => {
  let summarized = false;
  let seen: Message[] = [];
  const a = agent({
    compaction: compactingWith(() => (summarized = true)),
    *beforeRun() {
      return "Not today";
    },
    *model(request) {
      seen = request.messages;
      return {type: "final", text: "Sorry, I can't help with that."};
    },
  });
  const {result, stored} = await r.execute(
    context(),
    (function* () {
      const convo = yield* compactingConversation();
      const result = yield* a.run("go", {conversation: convo});
      return {result, stored: yield* convo.load()};
    })(),
  );
  assert.equal(summarized, true);
  // The summary is stored in place of the earlier turns; the rejection note is not.
  assert.equal(stored.summary, "summary");
  assert.deepEqual(stored.messages, [
    {role: "user", content: "go"},
    {role: "assistant", content: "Sorry, I can't help with that."},
  ]);
  // The summary replaced the earlier turns, and the note still follows the input.
  assert.match(JSON.stringify(seen[0]), /context-compacted/);
  assert.deepEqual(seen.slice(1), [
    {role: "user", content: "go"},
    {
      role: "user",
      content:
        '{"source":"agent-runtime","type":"error","origin":"beforeRun","code":"denied","message":"Not today"}',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result.messages), /Not today/);
});

void test("a truncation keeps the stored summary, and stores nothing", async () => {
  let seen: Message[] = [];
  const a = agent({
    // Without compaction, a request that would not fit the window is truncated.
    maxOutputTokens: 100,
    contextWindow: 300,
    *model(request) {
      seen = request.messages;
      return {type: "final", text: "done"};
    },
  });
  const stored = await r.execute(
    context(),
    (function* () {
      const convo = new LazyStateConversation({store: memoryStore().store});
      // The two messages the summary keeps are too long to survive the truncation.
      yield* convo.append(
        [
          ...pairs(2),
          {role: "user", content: "x".repeat(400)},
          {role: "assistant", content: "y".repeat(400)},
        ],
        0,
      );
      yield* convo.storeSummary("the stored summary", 2, 6);
      yield* a.run("next", {conversation: convo});
      return yield* convo.load();
    })(),
  );
  const note = JSON.parse((seen[0] as {content: string}).content);
  assert.equal(note.type, "context-truncated");
  assert.equal(note.handoff, "the stored summary");
  assert.deepEqual(seen.slice(1), [{role: "user", content: "next"}]);
  assert.equal(stored.summary, "the stored summary");
  assert.equal(stored.messages.length, 4);
});

void test("a conversation without storeSummary keeps working, and each run summarizes again", async () => {
  let summaries = 0;
  const a = agent({
    compaction: {
      maxTokens: 60,
      retainTokens: 20,
      *model() {
        summaries++;
        return {type: "final", text: "summary"};
      },
    },
    *model() {
      return {type: "final", text: "done"};
    },
  });
  const loaded = await r.execute(
    context(),
    (function* () {
      const inner = new LazyStateConversation({store: memoryStore().store});
      const plain: Conversation = {
        load: () => inner.load(),
        append: (messages, version) => inner.append(messages, version),
      };
      yield* inner.append(pairs(5), 0);
      yield* a.run("first", {conversation: plain});
      yield* a.run("second", {conversation: plain});
      return yield* inner.load();
    })(),
  );
  assert.equal(summaries, 2);
  assert.equal(loaded.summary, undefined);
  assert.equal(loaded.messages.length, 14);
});
