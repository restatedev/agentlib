import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import OpenAI from "openai";
import {APICallError} from "ai";
import {MockLanguageModelV4} from "ai/test";
import {
  agent,
  ContextOverflowError,
  isContextOverflow,
  tool,
  type JsonValue,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ProgressEvent,
} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {aiModel} from "@restate-agents/core/provider";
import {z} from "zod";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";

const context = () => testContext("context-window");
// 40000 characters: far above the default 1500-token preview threshold.
const page = Array.from({length: 4000}, (_, i) => `line ${String(i).padStart(4, "0")}`).join("\n");
const fetchPage = tool({
  description: "Fetch a page",
  input: z.object({}),
  *execute() {
    return page;
  },
});
const call = (id: string, name: string, input: JsonValue = {}) => ({
  type: "tool_calls" as const,
  calls: [{id, name, input}],
});
type Preview = {type: string; ref: string; head: string; tail: string; totalChars: number};

function toolOutput(request: ModelRequest, callId: string): JsonValue | undefined {
  const message = request.messages.find(
    (m): m is Extract<Message, {role: "tool"}> => m.role === "tool" && m.callId === callId,
  );
  return message?.result.status === "success" ? message.result.output : undefined;
}
const toolNames = (request: ModelRequest) => request.tools.map((t) => t.name);

void test("a large result reaches the model as a preview and is read back in slices", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    tools: {fetchPage},
    *model(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) return call("p1", "fetchPage");
      if (requests.length === 2)
        return call("r1", "read_tool_result", {ref: "p1", offset: 1000, limit: 500});
      return {type: "final", text: "Done"};
    },
  });
  const result = await r.execute(context(), a.run("Read the page"));
  assert.equal(result.status, "completed");

  // The reader appears with the first preview.
  assert.equal(toolNames(requests[0]!).includes("read_tool_result"), false);
  assert.ok(toolNames(requests[1]!).includes("read_tool_result"));

  const preview = toolOutput(requests[1]!, "p1") as Preview;
  assert.equal(preview.type, "tool-result-preview");
  assert.equal(preview.ref, "p1");
  assert.equal(preview.totalChars, page.length);
  assert.ok(page.startsWith(preview.head));
  assert.ok(page.endsWith(preview.tail));
  // 750 preview tokens at two characters each.
  assert.equal(preview.head.length + preview.tail.length, 1500);

  // A read is not previewed again.
  assert.deepEqual(toolOutput(requests[2]!, "r1"), {
    ref: "p1",
    offset: 1000,
    text: page.slice(1000, 1500),
    totalChars: page.length,
    nextOffset: 1500,
  });
  // The transcript keeps the whole result.
  const saved = result.messages.find((m) => m.role === "tool" && m.callId === "p1");
  assert.deepEqual(saved?.role === "tool" && saved.result, {status: "success", output: page});
});

void test("the reader ends at the last slice and rejects an unknown ref", async () => {
  const outputs: JsonValue[] = [];
  let step = 0;
  const a = agent({
    tools: {fetchPage},
    *model(request) {
      step++;
      if (step === 1) return call("p1", "fetchPage");
      if (step === 2)
        return {
          type: "tool_calls",
          calls: [
            {
              id: "r1",
              name: "read_tool_result",
              input: {ref: "p1", offset: page.length - 10, limit: null},
            },
            {id: "r2", name: "read_tool_result", input: {ref: "nope", offset: null, limit: null}},
          ],
        };
      for (const id of ["r1", "r2"]) {
        const message = request.messages.find((m) => m.role === "tool" && m.callId === id);
        if (message?.role === "tool") outputs.push(message.result as JsonValue);
      }
      return {type: "final", text: "Done"};
    },
  });
  await r.execute(context(), a.run("Read the end"));
  assert.deepEqual(outputs[0], {
    status: "success",
    output: {
      ref: "p1",
      offset: page.length - 10,
      text: page.slice(-10),
      totalChars: page.length,
      nextOffset: null,
    },
  });
  assert.equal((outputs[1] as {code?: string}).code, "unknown_ref");
});

void test("a background result is previewed and readable by its operation id", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    tools: {
      crawl: tool({
        description: "Crawl in the background",
        input: z.object({}),
        background: true,
        *execute() {
          return page;
        },
      }),
    },
    *model(request) {
      requests.push(structuredClone(request));
      const step = requests.length;
      if (step === 1) return call("c1", "crawl");
      const note = request.messages.find(
        (m) => m.role === "user" && m.content.includes('"background-tool-result"'),
      );
      if (!note) return call(`w${step}`, "read_tool_result", {ref: "c1", offset: 0, limit: 10});
      const parsed = JSON.parse(note.role === "user" ? note.content : "{}");
      assert.equal(parsed.result.output.type, "tool-result-preview");
      assert.equal(parsed.result.output.ref, "c1");
      if (step < 4) return call("b1", "read_tool_result", {ref: "c1", offset: 5, limit: 10});
      return {type: "final", text: "Done"};
    },
  });
  const result = await r.execute(context(), a.run("Crawl"));
  assert.equal(result.status, "completed");
  const read = requests
    .map((request) => toolOutput(request, "b1"))
    .find((output) => output !== undefined) as {text: string} | undefined;
  assert.equal(read?.text, page.slice(5, 15));
});

void test("toolResults: false shows every result in full", async () => {
  const requests: ModelRequest[] = [];
  const a = agent({
    tools: {fetchPage},
    toolResults: false,
    *model(request) {
      requests.push(structuredClone(request));
      return requests.length === 1 ? call("p1", "fetchPage") : {type: "final", text: "Done"};
    },
  });
  await r.execute(context(), a.run("Read"));
  assert.equal(toolOutput(requests[1]!, "p1"), page);
  assert.equal(toolNames(requests[1]!).includes("read_tool_result"), false);
});

void test("preview settings are validated and the reader's name is reserved", async () => {
  const model: Model = function* () {
    return {type: "final", text: ""};
  };
  assert.throws(
    () => agent({model, toolResults: {maxTokens: 100, previewTokens: 100}}),
    /previewTokens must be less than/,
  );
  const a = agent({model});
  await assert.rejects(
    r.execute(context(), a.run("Go", {tools: {read_tool_result: fetchPage}})),
    /Duplicate tool name: read_tool_result/,
  );
});

void test("reported usage triggers compaction that the message estimate alone would not", async () => {
  const run = async (reported: (step: number) => number | undefined) => {
    let compactions = 0;
    let step = 0;
    const a = agent({
      tools: {
        small: tool({
          description: "A small result",
          input: z.object({}),
          *execute() {
            return "ok";
          },
        }),
      },
      *model() {
        step++;
        const inputTokens = reported(step);
        const usage = inputTokens === undefined ? {} : {usage: {inputTokens, outputTokens: 5}};
        if (step <= 3) return {...call(`s${step}`, "small"), ...usage};
        return {type: "final", text: "Done", ...usage};
      },
      compaction: {
        maxTokens: 5000,
        retainTokens: 20,
        *model() {
          compactions++;
          return {type: "final", text: "note"};
        },
      },
    });
    const result = await r.execute(context(), a.run("Go"));
    assert.equal(result.status, "completed");
    return compactions;
  };
  // Instructions and tools count in the reported input, not in the estimate.
  assert.equal(await run(() => undefined), 0);
  assert.equal(await run(() => 100), 0);
  // One large report compacts once; the smaller view that follows reports less.
  assert.equal(await run((step) => (step === 1 ? 6000 : 100)), 1);
});

void test("previews and usage replay from the journal", async () => {
  let fetches = 0;
  const journaled = (respond: (request: ModelRequest) => ModelResponse): Model =>
    function* (request) {
      return yield* r.run(async () => respond(request), {name: "model"});
    };
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        let step = 0;
        const a = agent({
          tools: {
            fetchPage: tool({
              description: "Fetch a page",
              input: z.object({}),
              *execute() {
                return yield* r.run(
                  async () => {
                    fetches++;
                    return page;
                  },
                  {name: "fetch"},
                );
              },
            }),
          },
          model: journaled((request) => {
            step++;
            const usage = {inputTokens: 10 * step, outputTokens: 1};
            if (step === 1) return {...call("p1", "fetchPage"), usage};
            if (step === 2)
              return {...call("r1", "read_tool_result", {ref: "p1", offset: 7, limit: 9}), usage};
            return {type: "final", text: JSON.stringify(toolOutput(request, "r1")), usage};
          }),
        });
        return yield* a.run("Go");
      })(),
    );
  const first = await runHandler(handler);
  assert.equal(JSON.parse(first.output.output).text, page.slice(7, 16));
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(fetches, 1);
});

void test("the adapters report usage", async () => {
  const client = new OpenAI({
    apiKey: "test-only",
    fetch: async () =>
      Response.json({
        choices: [{finish_reason: "stop", message: {content: "hi"}}],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 7,
          total_tokens: 127,
          prompt_tokens_details: {cached_tokens: 100},
        },
      }),
  });
  const provider = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{type: "text", text: "hi"}],
      finishReason: {unified: "stop", raw: "stop"},
      usage: {
        inputTokens: {total: 50, noCache: 10, cacheRead: 40, cacheWrite: 0},
        outputTokens: {total: 3, text: 3, reasoning: 0},
      },
      warnings: [],
    }),
  });
  const request: ModelRequest = {messages: [{role: "user", content: "hi"}], tools: []};
  const ask = (model: Model) => runHandler((ctx) => r.execute(ctx, model(request)));
  const openai = await ask(openAIModel({client, model: "test-model"}));
  assert.deepEqual(openai.output.usage, {
    inputTokens: 120,
    outputTokens: 7,
    cachedInputTokens: 100,
  });
  const ai = await ask(aiModel({model: provider}));
  assert.deepEqual(ai.output.usage, {inputTokens: 50, outputTokens: 3, cachedInputTokens: 40});
});

const small = tool({
  description: "A small result",
  input: z.object({}),
  *execute() {
    return "x".repeat(400);
  },
});
const firstNote = (request: ModelRequest) => {
  const first = request.messages[0];
  return first?.role === "user" && first.content.startsWith("{")
    ? (JSON.parse(first.content) as {type: string; request?: string; handoff?: string})
    : undefined;
};

/** Rejects any view of more than `limit` messages, as a provider rejects a long prompt. */
function windowed(limit: number, steps: number) {
  const requests: ModelRequest[] = [];
  let overflows = 0;
  const model: Model = function* (request) {
    if (request.messages.length > limit) {
      overflows++;
      throw new ContextOverflowError("prompt is too long");
    }
    requests.push(structuredClone(request));
    return requests.length <= steps
      ? call(`s${requests.length}`, "small")
      : {type: "final", text: "Done"};
  };
  return {model, requests, overflows: () => overflows};
}

void test("an overflow truncates the view and asks again", async () => {
  const fixture = windowed(6, 5);
  const events: ProgressEvent[] = [];
  const a = agent({tools: {small}, model: fixture.model});
  const result = await r.execute(
    context(),
    a.run("Go", {
      *onProgress(event) {
        if (event.type === "compaction") events.push(event);
      },
    }),
  );
  assert.equal(result.status, "completed");
  assert.ok(fixture.overflows() >= 1);
  assert.equal(events.length, fixture.overflows());
  for (const event of events)
    assert.deepEqual(event, {
      type: "compaction",
      mode: "truncate",
      status: "applied",
      reason: "overflow",
    });
  const after = fixture.requests.find((request) => firstNote(request));
  assert.equal(firstNote(after!)?.type, "context-truncated");
  assert.equal(firstNote(after!)?.request, "Go");
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 5);
});

void test("with compaction set, an overflow summarizes below the threshold", async () => {
  const fixture = windowed(6, 5);
  const events: ProgressEvent[] = [];
  const a = agent({
    tools: {small},
    model: fixture.model,
    compaction: {
      *model() {
        return {type: "final", text: "read pages"};
      },
    },
  });
  await r.execute(
    context(),
    a.run("Go", {
      *onProgress(event) {
        if (event.type === "compaction") events.push(event);
      },
    }),
  );
  assert.ok(events.length >= 1);
  assert.deepEqual(events[0], {
    type: "compaction",
    mode: "summary",
    status: "applied",
    reason: "overflow",
  });
  assert.equal(
    firstNote(fixture.requests.find((request) => firstNote(request))!)?.handoff,
    "read pages",
  );
});

void test("an overflow that shrinking cannot fix fails the run", async () => {
  // Even the input alone overflows.
  const fixture = windowed(0, 1);
  const a = agent({tools: {small}, model: fixture.model});
  await assert.rejects(r.execute(context(), a.run("Go")), (error) => isContextOverflow(error));
  // One recovery: the input gives way to a note restating it, which still overflows.
  assert.equal(fixture.overflows(), 2);

  // A view that still overflows after one cut is not cut again in that step.
  let asked = 0;
  const always = agent({
    tools: {small},
    *model() {
      if (++asked > 1) throw new ContextOverflowError("prompt is too long");
      return call("s1", "small");
    },
  });
  await assert.rejects(r.execute(context(), always.run("Go")), (error) => isContextOverflow(error));
  assert.equal(asked, 3);
});

void test("overflow recovery replays from the journal", async () => {
  let calls = 0;
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        let step = 0;
        const a = agent({
          tools: {small},
          *model(request) {
            return yield* r.run(
              async () => {
                calls++;
                if (request.messages.length > 6)
                  throw new ContextOverflowError("prompt is too long");
                step++;
                return step <= 5
                  ? call(`s${step}`, "small")
                  : {type: "final" as const, text: "Done"};
              },
              {name: "model"},
            );
          },
        });
        const result = yield* a.run("Go");
        return result.messages.length;
      })(),
    );
  const first = await runHandler(handler);
  const live = calls;
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(calls, live);
});

void test("the adapters classify an overflow by its code, never its message", async () => {
  const request: ModelRequest = {messages: [{role: "user", content: "hi"}], tools: []};
  const failure = (model: Model) =>
    runHandler((ctx) =>
      r.execute(
        ctx,
        (function* () {
          try {
            yield* model(request);
            return "no error";
          } catch (error) {
            return isContextOverflow(error) ? "overflow" : "other";
          }
        })(),
      ),
    );
  const openai = (status: number, error: Record<string, unknown>) =>
    openAIModel({
      model: "test-model",
      client: new OpenAI({
        apiKey: "test-only",
        maxRetries: 0,
        fetch: async () => Response.json({error}, {status}),
      }),
    });
  assert.equal(
    (
      await failure(
        openai(400, {
          message: "This model's maximum context length is 128000 tokens.",
          code: "context_length_exceeded",
        }),
      )
    ).output,
    "overflow",
  );
  // The same words without the code are not an overflow.
  assert.equal(
    (
      await failure(
        openai(400, {message: "This model's maximum context length is 128000 tokens.", code: null}),
      )
    ).output,
    "other",
  );
  assert.equal((await failure(openai(413, {message: "Request too large"}))).output, "overflow");

  const ai = (message: string, statusCode: number) =>
    aiModel({
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message,
            statusCode,
            url: "https://example.test",
            requestBodyValues: {},
            isRetryable: false,
          });
        },
      }),
    });
  // Anthropic words an overflow as a plain 400; contextWindow avoids it instead.
  assert.equal(
    (await failure(ai("prompt is too long: 210000 tokens > 200000 maximum", 400))).output,
    "other",
  );
  assert.equal((await failure(ai("Request too large", 413))).output, "overflow");
  assert.equal((await failure(ai("Invalid request", 400))).output, "other");
});

void test("contextWindow shrinks a view that would not fit before asking", async () => {
  const run = async (compaction?: {retainTokens: number}) => {
    const requests: ModelRequest[] = [];
    const events: ProgressEvent[] = [];
    let step = 0;
    const a = agent({
      // About 1150 tokens each, under the preview threshold: three outgrow a quarter of the window.
      tools: {
        medium: tool({
          description: "A medium result",
          input: z.object({}),
          *execute() {
            return "x".repeat(2300);
          },
        }),
      },
      contextWindow: 10000,
      maxOutputTokens: 1000,
      ...(compaction
        ? {
            compaction: {
              ...compaction,
              *model() {
                return {type: "final" as const, text: "note"};
              },
            },
          }
        : {}),
      *model(request) {
        requests.push(structuredClone(request));
        step++;
        // Only the reported usage, which counts instructions too, shows the view near the window.
        const usage = {inputTokens: step === 3 ? 9500 : 500, outputTokens: 10};
        if (step <= 4) return {...call(`m${step}`, "medium"), usage};
        return {type: "final", text: "Done", usage};
      },
    });
    const result = await r.execute(
      context(),
      a.run("Go", {
        *onProgress(event) {
          if (event.type === "compaction") events.push(event);
        },
      }),
    );
    assert.equal(result.status, "completed");
    return {requests, events};
  };
  const truncated = await run();
  assert.deepEqual(truncated.events, [
    {type: "compaction", mode: "truncate", status: "applied", reason: "window"},
  ]);
  assert.equal(firstNote(truncated.requests[2]!), undefined);
  assert.equal(firstNote(truncated.requests[3]!)?.type, "context-truncated");

  const summarized = await run({retainTokens: 100});
  assert.deepEqual(summarized.events, [
    {type: "compaction", mode: "summary", status: "applied", reason: "window"},
  ]);
});

void test("contextWindow must leave room for the output", () => {
  const model: Model = function* () {
    return {type: "final", text: ""};
  };
  assert.throws(
    () => agent({model, contextWindow: 4096, maxOutputTokens: 4096}),
    /contextWindow must be greater than maxOutputTokens/,
  );
});
