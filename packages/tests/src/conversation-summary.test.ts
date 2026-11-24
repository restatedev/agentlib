// A run that compacts its context stores the summary in its conversation, in
// place of the messages the summary replaces, and the next run starts from it.
// The randomized test runs seeded multi-turn conversations and checks, after
// every turn, that the stored boundary covers exactly the summarized messages,
// that no message is summarized twice, and that the stored conversation loads
// as a valid history. A failure names the seed that reproduces it.
import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  AgentTerminalError,
  ContextOverflowError,
  LazyStateConversation,
  messagesOf,
  tool,
  type Conversation,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from "@restatedev/agentlib";
import {history} from "../../core/src/validation.js";
import {memoryStore, testContext} from "./helpers.js";

/** A context whose logger records warnings, so a test can check what the run logged. */
function recordingContext(warnings: string[]): Context {
  const quiet = new Proxy(console, {
    get(target, name) {
      if (name === "warn" || name === "error")
        return (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      return typeof (target as never)[name] === "function"
        ? () => undefined
        : (target as never)[name];
    },
  });
  return {...testContext("conversation-summary"), console: quiet} as unknown as Context;
}

/** mulberry32: a small seeded generator, so every scenario can be reproduced. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Identifies a message by what it says. Every message in these tests says something
 * unique. A tool result is identified by its call, since a preview changes its text. */
function key(message: Message): string {
  if (message.role === "tool") return `tool|${message.callId}`;
  const calls = message.role === "assistant" ? JSON.stringify(message.calls ?? []) : "";
  return `${message.role}|${message.content}|${calls}`;
}

function runtimeNote(message: Message | undefined): {type?: string; [k: string]: unknown} {
  if (message?.role !== "user" || !message.content.startsWith("{")) return {};
  const parsed = JSON.parse(message.content) as {source?: string; type?: string};
  return parsed.source === "agent-runtime" ? parsed : {};
}

const isContextNote = (message: Message | undefined) =>
  ["context-compacted", "context-truncated"].includes(runtimeNote(message).type ?? "");
const isNoteRequest = (request: ModelRequest) =>
  runtimeNote(request.messages.at(-1)).type === "handoff-note-request";

/** The messages a summary request asks the model to replace. */
function summarized(request: ModelRequest): Message[] {
  if (isNoteRequest(request)) {
    // The agent's own model: its view, then a request to replace all but the last `kept`.
    const instruction = String(runtimeNote(request.messages.at(-1)).instruction);
    const kept = Number(/except the last (\d+)/.exec(instruction)![1]);
    const view = request.messages.slice(0, -1);
    return view.slice(isContextNote(view[0]) ? 1 : 0, view.length - kept);
  }
  // A separate request: the messages as JSON, each clipped (these are short).
  const payload = JSON.parse((request.messages[0] as {content: string}).content) as {
    messages: string[];
  };
  return payload.messages.map((text) => JSON.parse(text) as Message);
}

const isSummaryRequest = (request: ModelRequest) =>
  request.name === "Compact context" || isNoteRequest(request);

void test("randomized conversations store exactly what their summaries replace", async (t) => {
  // SUMMARY_SEEDS runs more scenarios, for a longer search than the default suite.
  const seeds = Array.from({length: Number(process.env.SUMMARY_SEEDS ?? 300)}, (_, i) => i + 1);
  const stats: Stats = {
    turns: 0,
    summaries: 0,
    stored: 0,
    failedRuns: 0,
    stopped: 0,
    interrupted: 0,
    killed: 0,
    steering: 0,
    previews: 0,
    rejected: 0,
  };
  for (const seed of seeds) {
    const warnings: string[] = [];
    await r.execute(recordingContext(warnings), scenario(seed, stats));
    // Only the summaries this test fails on purpose may fail.
    assert.deepEqual(
      warnings.filter((w) => !w.includes("compactor down")),
      [],
      `seed ${seed}: unexpected warnings`,
    );
  }
  t.diagnostic(`${seeds.length} scenarios: ${JSON.stringify(stats)}`);
  // The scenarios must reach the paths they exist to test.
  assert.ok(stats.summaries > 300, `summaries: ${stats.summaries}`);
  assert.ok(stats.stored > 300, `stored summaries: ${stats.stored}`);
  assert.ok(stats.failedRuns > 10, `failed runs: ${stats.failedRuns}`);
  assert.ok(stats.stopped > 10, `stopped runs: ${stats.stopped}`);
  assert.ok(stats.steering > 50, `steering messages: ${stats.steering}`);
  assert.ok(stats.interrupted > 5, `interrupted runs: ${stats.interrupted}`);
  assert.ok(stats.killed > 10, `killed runs: ${stats.killed}`);
  assert.ok(stats.previews > 50, `requests with previews: ${stats.previews}`);
  assert.ok(stats.rejected > 50, `rejected answers: ${stats.rejected}`);
});

type Stats = {
  turns: number;
  summaries: number;
  stored: number;
  failedRuns: number;
  stopped: number;
  interrupted: number;
  killed: number;
  steering: number;
  previews: number;
  rejected: number;
};

function* scenario(seed: number, stats: Stats): r.Operation<void> {
  const random = prng(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const {store, values} = memoryStore();
  const conversation = new LazyStateConversation({store});
  const covered = new Set<string>();
  const where = (turn: number) => `seed ${seed}, turn ${turn}`;
  let turn = 0;
  let texts = 0;
  let calls = 0;
  let rejections = 0;
  /** Answers `afterRun` rejected: no summary may read them. */
  const rejected = new Set<string>();
  // The run treats an error thrown by its summarizer as a failed summary, so the
  // summarizer records violations and each turn checks them.
  const violations: string[] = [];

  const previews = random() < 0.4;
  // With previews on, the reader tool's schema alone takes about 350 tokens.
  const maxTokens = (previews ? 700 : 300) + pick(1200);
  const retainTokens = 40 + pick(Math.floor(maxTokens / 2) - 40);
  const ownModel = random() < 0.5;
  const contextWindow = random() < 0.3 ? 4096 + 200 + pick(maxTokens) : undefined;
  const compactorFails = random() < 0.2;

  /** Records what a summary replaces; no message may be summarized twice. */
  function* summarize(request: ModelRequest): r.Operation<ModelResponse> {
    if (compactorFails && random() < 0.15) throw new Error("compactor down");
    // A summary may be stored, so it never reads what the conversation never stores.
    const sent = JSON.stringify(request.messages);
    for (const answer of rejected)
      if (sent.includes(answer)) violations.push(`${where(turn)}: a summary read ${answer}`);
    if (sent.includes("not yet "))
      violations.push(`${where(turn)}: a summary read a rejection note`);
    for (const message of summarized(request)) {
      if (covered.has(key(message)))
        violations.push(`${where(turn)}: summarized twice: ${key(message)}`);
      covered.add(key(message));
    }
    stats.summaries++;
    return {type: "final", text: `summary ${seed}.${++texts}`};
  }

  let waiter: ReturnType<typeof r.channel<string>> | undefined;
  let interrupt: ReturnType<typeof r.channel<string>> | undefined;
  const size = (callId: string) => 20 + ((callId.length * 7919 + Number(callId.slice(1))) % 1500);
  const a = agent({
    codeMode: false,
    toolResults: previews ? {maxTokens: 60, previewTokens: 30} : false,
    maxSteps: 2 + pick(7),
    ...(contextWindow ? {contextWindow} : {}),
    compaction: {
      maxTokens,
      retainTokens,
      ...(ownModel ? {} : {model: summarize}),
    },
    tools: {
      data: tool({
        description: "Data",
        input: z.object({}),
        *execute(_input, context) {
          return `data ${context.callId} ${"x".repeat(size(context.callId))}`;
        },
      }),
      steer: tool({
        description: "Steer",
        input: z.object({}),
        *execute(_input, context) {
          // Steering that arrives during a batch is recorded between its calls and results.
          const channel = waiter;
          waiter = undefined;
          if (channel) {
            stats.steering++;
            yield* channel.send(`steer ${context.callId}`);
          }
          return `steered ${context.callId}`;
        },
      }),
      bg: tool({
        description: "Background",
        input: z.object({}),
        background: true,
        *execute(_input, context) {
          return `bg ${context.callId}`;
        },
      }),
      halt: tool({
        description: "Halt",
        input: z.object({}),
        *execute() {
          // Interrupts the run, then waits until the run stops this call.
          const channel = interrupt;
          interrupt = undefined;
          if (channel) yield* channel.send("user left");
          yield* r.channel<void>().receive;
          return "unreachable";
        },
      }),
      boom: tool({
        description: "Boom",
        input: z.object({}),
        *execute(_input, context) {
          throw new AgentTerminalError(`boom ${context.callId}`);
        },
      }),
    },
    *afterRun(candidate) {
      // Rejected answers are provisional: the model sees them, the conversation never does.
      if (candidate.status === "completed" && random() < 0.15) {
        rejected.add(String(candidate.output));
        stats.rejected++;
        return `not yet ${++rejections}`;
      }
    },
    *model(request) {
      if (isSummaryRequest(request)) return yield* summarize(request);
      if (request.name === "Summarize stopped run")
        return {type: "final", text: `stopped ${seed}.${++texts}`};
      history(request.messages);
      if (JSON.stringify(request.messages).includes('"tool-result-preview"')) stats.previews++;
      if (random() < 0.15 + 0.1 * request.step!)
        return {type: "final", text: `answer [${seed}.${++texts}]`};
      const names = ["data", "data", "data", "steer", "bg", "bg"];
      const name = () => {
        if (random() < 0.02) return "boom";
        if (random() < 0.02) return "halt";
        return names[pick(names.length)]!;
      };
      return {
        type: "tool_calls",
        calls: Array.from({length: 1 + pick(3)}, () => ({
          id: `c${++calls}`,
          name: name(),
          input: {},
        })),
      };
    },
  });

  for (turn = 1; turn <= 3 + pick(4); turn++) {
    stats.turns++;
    if (turn > 1 && random() < 0.1) {
      // A killed run left a call without a result; this run closes it.
      stats.killed++;
      const count = (values.get("conversation/meta") as {count: number}).count;
      yield* conversation.append(
        [
          {role: "user", content: `killed ${seed}.${turn}`},
          {role: "assistant", content: "", calls: [{id: `k${turn}`, name: "data", input: {}}]},
        ],
        count,
      );
    }
    const loaded = yield* conversation.load();
    const throughAtLoad =
      (values.get("conversation/meta") as {summary?: {through: number}} | undefined)?.summary
        ?.through ?? 0;
    let messages: Message[];
    try {
      const result = yield* a.run(`turn ${seed}.${turn}`, {
        conversation,
        controls: {
          steering: () => {
            const channel = r.channel<string>();
            waiter = channel;
            return channel.receive;
          },
          interrupt: (interrupt = r.channel<string>()).receive,
        },
      });
      if (result.status === "stopped") stats.stopped++;
      if (result.status === "interrupted") stats.interrupted++;
      messages = result.messages;
    } catch (error) {
      if (!(error instanceof AgentTerminalError)) throw error;
      stats.failedRuns++;
      messages = messagesOf(error)!;
    }
    assert.deepEqual(violations, [], where(turn));
    const meta = values.get("conversation/meta") as {
      count: number;
      summary?: {through: number; text: string};
    };
    const through = meta.summary?.through ?? 0;
    if (through > throughAtLoad) stats.stored++;
    const saved = (yield* conversation.page(0, 1000)).messages;
    assert.equal(saved.length, meta.count, where(turn));
    // Exactly the summarized messages come before the stored boundary.
    saved.forEach((message, i) =>
      assert.equal(
        i < through,
        covered.has(key(message)),
        `${where(turn)}: message ${i} of ${saved.length}, boundary ${through}: ${key(message)}`,
      ),
    );
    // The run returned what it loaded and saved; the next run loads a valid history.
    assert.deepEqual(messages, saved.slice(throughAtLoad), where(turn));
    const next = yield* conversation.load();
    assert.deepEqual(next.messages, saved.slice(through), where(turn));
    history(next.messages);
    assert.equal(next.summary, meta.summary?.text, where(turn));
    if (loaded.summary !== undefined) assert.ok(through >= throughAtLoad, where(turn));
  }
}

const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute(_input, context) {
    return `page ${context.callId} ${"x".repeat(400)}`;
  },
});

void test("a summary written by an earlier version of the library loads as the run's note", async () => {
  const {store, values} = memoryStore();
  // Conversation compaction stored its summary in the same place, before this change.
  values.set("conversation/0", [
    {role: "user", content: "question 0"},
    {role: "assistant", content: "answer 0"},
    {role: "user", content: "question 1"},
    {role: "assistant", content: "answer 1"},
  ]);
  values.set("conversation/meta", {count: 4, summary: {through: 2, text: "asked about zero"}});
  let seen: Message[] = [];
  const a = agent({
    *model(request) {
      seen = request.messages;
      return {type: "final", text: "answer 2"};
    },
  });
  const result = await r.execute(
    testContext("legacy"),
    a.run("question 2", {conversation: new LazyStateConversation({store})}),
  );
  const note = runtimeNote(seen[0]);
  assert.equal(note.type, "context-compacted");
  assert.equal(note.handoff, "asked about zero");
  assert.deepEqual(seen.slice(1).map(key), [
    "user|question 1|",
    "assistant|answer 1|[]",
    "user|question 2|",
  ]);
  // The returned messages are the ones the run loaded and added, without the note.
  assert.equal(result.messages.length, 4);
  assert.deepEqual(values.get("conversation/meta"), {
    count: 6,
    summary: {through: 2, text: "asked about zero"},
  });
});

void test("a summary too long to store is logged, and the next run summarizes again", async () => {
  const warnings: string[] = [];
  let summaries = 0;
  const a = agent({
    codeMode: false,
    toolResults: false,
    tools: {read},
    compaction: {
      maxTokens: 400,
      retainTokens: 100,
      *model() {
        summaries++;
        return {type: "final", text: "s".repeat(64001)};
      },
    },
    *model(request) {
      return request.step === 1
        ? {
            type: "tool_calls",
            calls: [{id: `r${request.messages.length}`, name: "read", input: {}}],
          }
        : {type: "final", text: `done ${request.messages.length}`};
    },
  });
  const stored = await r.execute(
    recordingContext(warnings),
    (function* () {
      const conversation = new LazyStateConversation({store: memoryStore().store});
      yield* conversation.append(
        Array.from({length: 6}, (_, i) => ({
          role: i % 2 ? ("assistant" as const) : ("user" as const),
          content: `turn ${i} ${"x".repeat(200)}`,
        })),
        0,
      );
      yield* a.run("first", {conversation});
      yield* a.run("second", {conversation});
      return yield* conversation.load();
    })(),
  );
  assert.ok(summaries >= 2);
  assert.equal(stored.summary, undefined);
  assert.ok(warnings.some((w) => w.includes("Could not store the run's summary")));
});

void test("a conversation whose store fails keeps the run going; an AgentTerminalError fails it", async () => {
  const failingWith = (error: () => Error): {conversation: Conversation; stored: string[]} => {
    const inner = new LazyStateConversation({store: memoryStore().store});
    const stored: string[] = [];
    return {
      stored,
      conversation: {
        load: () => inner.load(),
        append: (messages, version) => inner.append(messages, version),
        *storeSummary(summary) {
          stored.push(summary);
          throw error();
        },
      },
    };
  };
  const a = agent({
    compaction: {
      maxTokens: 60,
      retainTokens: 20,
      *model() {
        return {type: "final", text: "summary"};
      },
    },
    *model() {
      return {type: "final", text: "done"};
    },
  });
  const earlier: Message[] = [
    {role: "user", content: "first ".repeat(40)},
    {role: "assistant", content: "one ".repeat(40)},
  ];
  const warnings: string[] = [];
  const ok = failingWith(() => new Error("store down"));
  const result = await r.execute(
    recordingContext(warnings),
    (function* () {
      yield* ok.conversation.append(earlier, 0);
      return yield* a.run("next", {conversation: ok.conversation});
    })(),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(ok.stored, ["summary"]);
  assert.ok(warnings.some((w) => w.includes("store down")));

  const fatal = failingWith(() => new AgentTerminalError("not allowed"));
  await assert.rejects(
    r.execute(
      recordingContext([]),
      (function* () {
        yield* fatal.conversation.append(earlier, 0);
        return yield* a.run("next", {conversation: fatal.conversation});
      })(),
    ),
    {name: "AgentTerminalError", message: "not allowed"},
  );
});

void test("a summary made to recover from an overflow is stored", async () => {
  let attempts = 0;
  const a = agent({
    codeMode: false,
    toolResults: false,
    tools: {read},
    // maxTokens is far away; only the overflow makes the run compact.
    compaction: {
      maxTokens: 100000,
      *model() {
        return {type: "final", text: "recovered summary"};
      },
    },
    *model(request) {
      if (request.step === 1)
        return {type: "tool_calls", calls: [{id: "r1", name: "read", input: {}}]};
      if (++attempts === 1) throw new ContextOverflowError("prompt is too long");
      return {type: "final", text: "done"};
    },
  });
  const stored = await r.execute(
    testContext("overflow"),
    (function* () {
      const conversation = new LazyStateConversation({store: memoryStore().store});
      yield* conversation.append(
        [
          {role: "user", content: `old question ${"x".repeat(2000)}`},
          {role: "assistant", content: `old answer ${"x".repeat(2000)}`},
        ],
        0,
      );
      yield* a.run("go", {conversation});
      return yield* conversation.load();
    })(),
  );
  assert.equal(attempts, 2);
  assert.equal(stored.summary, "recovered summary");
  history(stored.messages);
});

void test("a ref from a summarized earlier turn cannot be read, and the model is told so", async () => {
  // A known limit: a later run loads only the messages after the stored summary,
  // so a previewed result from before it is no longer available to read_tool_result.
  const results: unknown[] = [];
  const a = agent({
    codeMode: false,
    tools: {read},
    toolResults: {maxTokens: 60, previewTokens: 20},
    // The tool schemas take about 350 tokens. The first run compacts before its
    // second step, and its summary replaces the read; the second run fits.
    compaction: {
      maxTokens: 750,
      retainTokens: 40,
      *model() {
        return {type: "final", text: "read page r1, ref r1"};
      },
    },
    *model(request) {
      const last = request.messages.at(-1);
      if (last?.role === "tool" && last.name === "read_tool_result") {
        results.push(last.result);
        return {type: "final", text: "could not read it"};
      }
      if (last?.role === "user" && last.content === "read it again")
        return {
          type: "tool_calls",
          calls: [
            {id: "again", name: "read_tool_result", input: {ref: "r1", offset: 0, limit: 100}},
          ],
        };
      return request.step === 1
        ? {type: "tool_calls", calls: [{id: "r1", name: "read", input: {}}]}
        : {type: "final", text: "read it"};
    },
  });
  await r.execute(
    testContext("refs"),
    (function* () {
      const conversation = new LazyStateConversation({store: memoryStore().store});
      yield* conversation.append(
        [
          {role: "user", content: `old ${"x".repeat(600)}`},
          {role: "assistant", content: `old ${"y".repeat(600)}`},
        ],
        0,
      );
      yield* a.run("read a page", {conversation});
      assert.ok((yield* conversation.load()).summary);
      yield* a.run("read it again", {conversation});
    })(),
  );
  assert.deepEqual(results, [
    {status: "error", code: "unknown_ref", message: "No tool result to read for ref r1"},
  ]);
});

for (const ownModel of [false, true])
  void test(`summaries leave out an answer afterRun rejected (${ownModel ? "agent's model" : "compactor"})`, async () => {
    const summaryRequests: string[] = [];
    // The summary copies what it read, so a leak would reach the stored text.
    const copy = function* (request: ModelRequest): r.Operation<ModelResponse> {
      const read = JSON.stringify(request.messages);
      summaryRequests.push(read);
      return {type: "final", text: read.slice(0, 60000)};
    };
    let answers = 0;
    const a = agent({
      codeMode: false,
      toolResults: false,
      tools: {read},
      // The read's result outgrows maxTokens before step 3, and nothing fits retainTokens.
      compaction: {maxTokens: 300, retainTokens: 40, ...(ownModel ? {} : {model: copy})},
      *afterRun() {
        if (answers++ === 0) return "Do not share the code";
      },
      *model(request) {
        if (request.name === "Compact context") return yield* copy(request);
        if (request.step === 1) return {type: "final", text: "Your code is SECRET-123"};
        if (request.step === 2)
          return {type: "tool_calls", calls: [{id: "r1", name: "read", input: {}}]};
        return {type: "final", text: "done"};
      },
    });
    const {result, stored} = await r.execute(
      testContext("rejected"),
      (function* () {
        const conversation = new LazyStateConversation({store: memoryStore().store});
        const result = yield* a.run("What is my code?", {conversation});
        return {result, stored: yield* conversation.load()};
      })(),
    );
    assert.equal(result.status, "completed");
    assert.equal(summaryRequests.length, 1);
    assert.doesNotMatch(summaryRequests[0]!, /SECRET-123|Do not share/);
    assert.match(stored.summary!, /What is my code/);
    assert.doesNotMatch(stored.summary!, /SECRET-123/);
    assert.doesNotMatch(JSON.stringify(result.messages), /SECRET-123/);
  });
