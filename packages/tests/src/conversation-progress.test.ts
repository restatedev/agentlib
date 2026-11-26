// A run with a conversation saves as it goes, and a failed run saves what it
// committed with a note on the failure. These tests read the store the way a
// shared handler reads it, while the run continues.
import assert from "node:assert/strict";
import {test} from "node:test";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  AgentTerminalError,
  ConversationConflictError,
  LazyStateConversation,
  messagesOf,
  tool,
  type Conversation,
  type ConversationSnapshot,
  type ConversationStore,
  type Message,
  type Model,
  type ModelResponse,
  type ToolResult,
} from "@restatedev/agentlib";
import {history} from "../../core/src/validation.js";
import {memoryStore, testContext} from "./helpers.js";

const ctx = () => testContext("conversation-progress");
const base = {description: "fixture", input: z.object({})};
const done: ModelResponse = {type: "final", text: "done"};
const batch = (...ids: string[]): ModelResponse => ({
  type: "tool_calls",
  calls: ids.map((id) => ({id, name: id, input: {}})),
});
const user = (content: string): Message => ({role: "user", content});
const answer = (content: string): Message => ({role: "assistant", content});
const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: "",
  calls: ids.map((id) => ({id, name: id, input: {}})),
});
const resultOf = (id: string, result: ToolResult): Message => ({
  role: "tool",
  callId: id,
  name: id,
  result,
});
const success = (id: string, output: string) => resultOf(id, {status: "success", output});
const cancelled = (id: string, message: string) => resultOf(id, {status: "cancelled", message});
const note = (type: string, message: string): Message =>
  user(JSON.stringify({source: "agent-runtime", type, message}));
const interrupted =
  "Interrupted: the run that made this call ended before the call returned a result. It may have taken effect.";
const pairs = (n: number): Message[] =>
  Array.from({length: n}, (_, i) => [user(`question ${i}`), answer(`answer ${i}`)]).flat();
const stop = (message: string): never => {
  throw new AgentTerminalError(message);
};

/** Runs `body` to completion in the in-process scheduler. */
function execute<T>(body: () => r.Operation<T>): Promise<T> {
  return r.execute(ctx(), body());
}

/** The error a run throws, from inside the scheduler. */
function* failure(run: r.Operation<unknown>): r.Operation<unknown> {
  try {
    yield* run;
  } catch (error) {
    return error;
  }
  return assert.fail("the run must fail");
}

void test("a shared reader sees each model call while the run continues", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  // Another instance on the same store stands in for a shared handler.
  const reader = new LazyStateConversation({store});
  const seen: Message[][] = [];
  await execute(function* () {
    const a = agent({
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            seen.push((yield* reader.page()).messages);
            // A history read mid-batch ends with the call, which has no result yet.
            assert.deepEqual((yield* reader.load()).messages, [user("go"), calls("lookup")]);
            return "found";
          },
        }),
      },
      *model(request) {
        seen.push((yield* reader.page()).messages);
        return request.step === 1 ? batch("lookup") : done;
      },
    });
    const result = yield* a.run("go", {conversation});
    // The batch's result is saved with the next save: here, when the turn ends.
    assert.deepEqual(seen, [[], [user("go"), calls("lookup")], [user("go"), calls("lookup")]]);
    assert.deepEqual((yield* reader.page()).messages, result.messages);
  });
});

void test("background results are saved with the next save", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const reader = new LazyStateConversation({store});
  await execute(function* () {
    const gate = r.channel<void>();
    let step = 0;
    const a = agent({
      tools: {
        job: tool({
          ...base,
          background: true,
          *execute() {
            yield* gate.receive;
            return "finished";
          },
        }),
      },
      *model() {
        if (++step === 1) return batch("job");
        if (step === 2) {
          // The pending acknowledgment is recorded as the call starts, so it is saved with it.
          assert.deepEqual((yield* reader.page()).messages, [
            user("go"),
            calls("job"),
            resultOf("job", {status: "pending", operationId: "job"}),
          ]);
          yield* gate.send(undefined);
          return {type: "final", text: "too early"};
        }
        // The run collected the result after the second request; the turn's end saves it.
        assert.doesNotMatch(JSON.stringify((yield* reader.page()).messages), /finished/);
        return done;
      },
    });
    const result = yield* a.run("go", {conversation});
    assert.equal(step, 3);
    const saved = (yield* reader.page()).messages;
    assert.match(JSON.stringify(saved), /background-tool-result.*finished/);
    assert.deepEqual(saved, result.messages);
  });
});

void test("a run that fails mid-batch saves its finished results, closes the rest, and says why", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    const a = agent({
      tools: {
        fast: tool({
          ...base,
          *execute() {
            return "fast";
          },
        }),
        halt: tool({
          ...base,
          *execute() {
            return stop("payment provider rejected the account");
          },
        }),
        slow: tool({
          ...base,
          *execute() {
            yield* r.channel<void>().receive;
            return "unreachable";
          },
        }),
      },
      *model() {
        return batch("fast", "halt", "slow");
      },
    });
    const error = yield* failure(a.run("go", {conversation}));
    assert.ok(error instanceof AgentTerminalError);
    const reason = "payment provider rejected the account";
    const saved = (yield* conversation.load()).messages;
    history(saved);
    assert.deepEqual(saved, [
      user("go"),
      calls("fast", "halt", "slow"),
      success("fast", "fast"),
      cancelled("halt", `Run failed: ${reason}`),
      cancelled("slow", `Run failed: ${reason}`),
      note("run-failed", reason),
    ]);
    assert.deepEqual(messagesOf(error), saved);
  });
});

void test("a model error fails the run, and the next run reads why", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    const failing = agent({
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            return "found";
          },
        }),
      },
      *model(request) {
        if (request.step === 1) return batch("lookup");
        throw new TerminalError("model unavailable");
      },
    });
    const error = yield* failure(failing.run("go", {conversation}));
    // The original error, unchanged.
    assert.ok(error instanceof TerminalError);
    assert.equal(error.message, "model unavailable");
    const failed = [
      user("go"),
      calls("lookup"),
      success("lookup", "found"),
      note("run-failed", "model unavailable"),
    ];
    assert.deepEqual((yield* conversation.load()).messages, failed);
    const next = agent({
      *model(request) {
        assert.deepEqual(request.messages, [...failed, user("again")]);
        return done;
      },
    });
    const result = yield* next.run("again", {conversation});
    assert.deepEqual((yield* conversation.load()).messages, result.messages);
  });
});

void test("a retryable error saves no failure note: Restate retries the invocation", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    const a = agent({
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            return "found";
          },
        }),
      },
      *model(request) {
        if (request.step === 1) return batch("lookup");
        throw new Error("connection reset");
      },
    });
    const error = yield* failure(a.run("go", {conversation}));
    assert.ok(!(error instanceof TerminalError));
    // Saved after the first model call; a retry replays this write and continues.
    const saved = [user("go"), calls("lookup")];
    assert.deepEqual((yield* conversation.load()).messages, saved);
    assert.deepEqual(messagesOf(error), [
      ...saved,
      success("lookup", "found"),
      note("run-failed", "connection reset"),
    ]);
  });
});

void test("a cancelled invocation saves its closed calls with a cancellation note", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    const a = agent({
      tools: {
        wait: tool({
          ...base,
          *execute() {
            // What Restate delivers to a cancelled invocation's pending work.
            throw new CancelledError();
          },
        }),
      },
      *model() {
        return batch("wait");
      },
    });
    const error = yield* failure(a.run("go", {conversation}));
    assert.ok(error instanceof CancelledError);
    const saved = (yield* conversation.load()).messages;
    history(saved);
    assert.deepEqual(saved, [
      user("go"),
      calls("wait"),
      cancelled("wait", `Run cancelled: ${error.message}`),
      note("run-cancelled", error.message),
    ]);
  });
});

void test("steering is saved when it arrives, and during a batch with the next save", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const reader = new LazyStateConversation({store});
  await execute(function* () {
    // Channels are one-shot: one per steering message.
    const first = r.channel<string>();
    const second = r.channel<string>();
    const never = r.channel<string>();
    const gate = r.channel<void>();
    const sources = [first, second];
    let step = 0;
    const snapshots: Message[][] = [];
    const a = agent({
      tools: {
        write: tool({
          ...base,
          *execute() {
            return "written";
          },
        }),
        steer: tool({
          ...base,
          *execute() {
            yield* second.send("Read it back");
            yield* gate.receive;
            return "steered";
          },
        }),
      },
      *model() {
        step++;
        if (step === 1) {
          yield* first.send("Use the new address");
          yield* r.channel<void>().receive;
          return {type: "final", text: "stale"};
        }
        return step === 2 ? batch("write", "steer") : done;
      },
    });
    const result = yield* a.run("go", {
      conversation,
      controls: {steering: () => (sources.shift() ?? never).receive},
      *onProgress(event) {
        if (event.type !== "steering") return;
        snapshots.push((yield* reader.page()).messages);
        if (snapshots.length === 2) yield* gate.send(undefined);
      },
    });
    assert.deepEqual(snapshots, [
      // During the first model call: the input and the steering note, at once.
      [user("go"), note("steering", "Use the new address")],
      // During the batch: nothing new. The note follows the batch's results, so a
      // later save stores it after them.
      [user("go"), note("steering", "Use the new address"), calls("write", "steer")],
    ]);
    const saved = (yield* reader.page()).messages;
    history(saved);
    assert.deepEqual(saved, [
      user("go"),
      note("steering", "Use the new address"),
      calls("write", "steer"),
      success("write", "written"),
      success("steer", "steered"),
      note("steering", "Read it back"),
      answer("done"),
    ]);
    assert.deepEqual(saved, result.messages);
  });
});

void test("an interrupted run saves its calls as they start and closes them when it stops", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const reader = new LazyStateConversation({store});
  await execute(function* () {
    const interrupt = r.channel<string>();
    const a = agent({
      finalize: false,
      tools: {
        slow: tool({
          ...base,
          *execute() {
            assert.deepEqual((yield* reader.page()).messages, [user("go"), calls("slow")]);
            yield* interrupt.send("user left");
            yield* r.channel<void>().receive;
            return "unreachable";
          },
        }),
      },
      *model() {
        return batch("slow");
      },
    });
    const result = yield* a.run("go", {conversation, controls: {interrupt: interrupt.receive}});
    assert.equal(result.status, "interrupted");
    const saved = (yield* reader.page()).messages;
    assert.deepEqual(saved, [user("go"), calls("slow"), cancelled("slow", "user left")]);
    assert.deepEqual(saved, result.messages);
  });
});

void test("the next run closes the calls a killed run left without results", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    // A run saved its calls and one result, then its invocation was killed.
    const left = [user("pay"), calls("charge", "email"), success("charge", "ok")];
    yield* conversation.append(left, 0);
    // Readers accept calls that are still running.
    assert.deepEqual((yield* conversation.load()).messages, left);
    const closed = cancelled("email", interrupted);
    const a = agent({
      *model(request) {
        assert.deepEqual(request.messages, [...left, closed, user("status?")]);
        return done;
      },
    });
    const result = yield* a.run("status?", {conversation});
    // The run's save stores the closing result, so the stored history is complete again.
    const saved = (yield* conversation.load()).messages;
    history(saved);
    assert.deepEqual(saved, result.messages);
  });
});

void test("compaction at the start of a run keeps the closing results", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const long = (i: number) => [
    user(`question ${i} ${"x".repeat(1000)}`),
    answer(`answer ${i} ${"x".repeat(1000)}`),
  ];
  await execute(function* () {
    yield* conversation.append([...long(0), ...long(1), user("pay"), calls("charge")], 0);
    const closed = cancelled("charge", interrupted);
    const a = agent({
      // The two long turns outgrow maxTokens; the killed run's turn fits retainTokens.
      compaction: {
        maxTokens: 400,
        retainTokens: 300,
        *model() {
          return {type: "final", text: "two earlier questions"};
        },
      },
      *model(request) {
        assert.match(JSON.stringify(request.messages[0]), /two earlier questions/);
        assert.deepEqual(request.messages.slice(1), [
          user("pay"),
          calls("charge"),
          closed,
          user("status?"),
        ]);
        return done;
      },
    });
    assert.equal((yield* a.run("status?", {conversation})).status, "completed");
    const loaded = yield* conversation.load();
    assert.equal(loaded.summary, "two earlier questions");
    assert.deepEqual(loaded.messages, [
      user("pay"),
      calls("charge"),
      closed,
      user("status?"),
      answer("done"),
    ]);
  });
});

void test("a run still rejects other broken histories, and repairs only its conversation", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    const a = agent({
      *model() {
        return assert.fail("the run must not call the model");
      },
    });
    // A message after a call without a result is not an abandoned batch.
    yield* conversation.append([user("pay"), calls("charge"), user("again")], 0);
    assert.match(String(yield* failure(a.run("go", {conversation}))), /answer every tool call/);
    // Messages a caller passes in are not repaired.
    const messages = [user("pay"), calls("charge")];
    assert.match(String(yield* failure(a.run("go", {messages}))), /unfinished tool calls/);
  });
});

void test("a summary made mid-run is stored at the next save, so a shared reader loads it", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  // Another instance on the same store stands in for a shared handler.
  const reader = new LazyStateConversation({store});
  let midRun: ConversationSnapshot | undefined;
  await execute(function* () {
    const a = agent({
      codeMode: false,
      toolResults: false,
      // The big result outgrows maxTokens before step 2, and it alone exceeds retainTokens.
      compaction: {
        maxTokens: 500,
        retainTokens: 150,
        *model() {
          return {type: "final", text: "looked up the big record"};
        },
      },
      tools: {
        big: tool({
          ...base,
          *execute() {
            return "x".repeat(1000);
          },
        }),
        small: tool({
          ...base,
          *execute() {
            midRun = yield* reader.load();
            return "ok";
          },
        }),
      },
      *model(request) {
        if (request.step === 1) return batch("big");
        if (request.step === 2) return batch("small");
        return done;
      },
    });
    assert.equal((yield* a.run("go", {conversation})).status, "completed");
  });
  // The save before `small` ran stored the summary in place of the first step.
  assert.equal(midRun?.summary, "looked up the big record");
  assert.deepEqual(midRun?.messages, [calls("small")]);
  await execute(function* () {
    const loaded = yield* conversation.load();
    assert.equal(loaded.summary, "looked up the big record");
    assert.deepEqual(loaded.messages, [calls("small"), success("small", "ok"), answer("done")]);
    // The chunks keep every message.
    assert.equal((yield* conversation.page()).messages.length, 6);
  });
});

void test("another writer fails the run's next save, which then saves no failure note", async () => {
  const {store} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const writer = new LazyStateConversation({store});
  await execute(function* () {
    const a = agent({
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            return "found";
          },
        }),
      },
      *model() {
        // Another writer appends before the run's first save.
        yield* writer.append([user("someone else")], 0);
        return batch("lookup");
      },
    });
    const error = yield* failure(a.run("go", {conversation}));
    assert.ok(error instanceof ConversationConflictError);
    assert.deepEqual((yield* writer.page()).messages, [user("someone else")]);
    assert.match(JSON.stringify(messagesOf(error)?.at(-1)), /run-failed/);
  });
});

void test("a failed run with messages exposes its history for the next run", async () => {
  const prior = [user("hi"), answer("hello")];
  await execute(function* () {
    const failing = agent({
      tools: {
        halt: tool({
          ...base,
          *execute() {
            return stop("quota exhausted");
          },
        }),
      },
      *model() {
        return batch("halt");
      },
    });
    const error = yield* failure(failing.run("go", {messages: prior}));
    const after = messagesOf(error);
    assert.ok(after);
    history(after);
    assert.deepEqual(after, [
      ...prior,
      user("go"),
      calls("halt"),
      cancelled("halt", "Run failed: quota exhausted"),
      note("run-failed", "quota exhausted"),
    ]);
    const next = agent({
      *model(request) {
        assert.deepEqual(request.messages, [...after, user("again")]);
        return done;
      },
    });
    assert.equal((yield* next.run("again", {messages: after})).status, "completed");
  });
});

void test("a run saves after each tool-call step and at the end, not after a tool batch", async () => {
  const {store} = memoryStore();
  const stored = new LazyStateConversation({store});
  const appended: number[] = [];
  const conversation: Conversation = {
    load: () => stored.load(),
    *append(messages, version) {
      appended.push(messages.length);
      return yield* stored.append(messages, version);
    },
  };
  await execute(function* () {
    const a = agent({
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            return "found";
          },
        }),
        check: tool({
          ...base,
          *execute() {
            return "checked";
          },
        }),
      },
      *model(request) {
        if (request.step === 1) return batch("lookup");
        return request.step === 2 ? batch("check") : done;
      },
    });
    yield* a.run("go", {conversation});
    // Each tool-call step saves its calls with the previous batch's result: the input
    // and first call, then the result and second call. The end adds the last result
    // and the answer.
    assert.deepEqual(appended, [2, 2, 2]);
    appended.length = 0;
    yield* agent({
      *model() {
        return done;
      },
    }).run("again", {conversation});
    // Without tool calls, the input and the answer are saved together when the turn ends.
    assert.deepEqual(appended, [2]);
  });
});

/** A memory store that counts the reads of each key. */
function countingStore() {
  const {store, values} = memoryStore();
  const reads = new Map<string, number>();
  const counted: ConversationStore = {
    *get<T>(key: string) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return yield* store.get<T>(key);
    },
    set: (key, value) => store.set(key, value),
  };
  return {store: counted, values, reads};
}

void test("a run reads each conversation key once, through compaction and every save", async () => {
  const {store, reads} = countingStore();
  const summarize: Model = function* () {
    return {type: "final", text: "twenty earlier questions"};
  };
  const conversation = new LazyStateConversation({store});
  // Five chunks of history, written by an earlier invocation.
  await execute(function* () {
    yield* new LazyStateConversation({store}).append(pairs(20), 0);
  });
  reads.clear();
  await execute(function* () {
    const a = agent({
      codeMode: false,
      toolResults: false,
      // Twenty earlier questions outgrow maxTokens before the first step.
      compaction: {model: summarize, maxTokens: 200, retainTokens: 50},
      tools: {
        lookup: tool({
          ...base,
          *execute() {
            return "found";
          },
        }),
      },
      *model(request) {
        if (request.step !== 1) return done;
        assert.match(JSON.stringify(request.messages[0]), /twenty earlier questions/);
        return batch("lookup");
      },
    });
    assert.equal((yield* a.run("go", {conversation})).status, "completed");
  });
  // The load, storing the summary, and the saves read each key once.
  assert.deepEqual(Object.fromEntries(reads), {
    "conversation/meta": 1,
    "conversation/0": 1,
    "conversation/1": 1,
    "conversation/2": 1,
    "conversation/3": 1,
    "conversation/4": 1,
  });
  await execute(function* () {
    assert.deepEqual((yield* conversation.page(40)).messages, [
      user("go"),
      calls("lookup"),
      success("lookup", "found"),
      answer("done"),
    ]);
  });
});

void test("the next invocation reads the store again, with the same instance", async () => {
  const {store, reads} = countingStore();
  const conversation = new LazyStateConversation({store});
  await execute(function* () {
    yield* conversation.append([user("one")], 0);
  });
  await execute(function* () {
    yield* new LazyStateConversation({store}).append([user("two")], 1);
  });
  await execute(function* () {
    assert.deepEqual((yield* conversation.load()).messages, [user("one"), user("two")]);
  });
  assert.equal(reads.get("conversation/meta"), 3);
});
