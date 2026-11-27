// What a forked sub-agent starts from and what it leaves behind. A fork starts
// from the parent's history as it stood at the step that called the fork tool,
// followed by the task, so its first request repeats that step's request. Tools
// are covered in fork-tools.test.ts and journal replay in fork-replay.test.ts.
import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {createAnthropic} from "@ai-sdk/anthropic";
import {z} from "zod";
import {
  agent,
  agentTool,
  Conversation,
  skills,
  tool,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ProgressEvent,
  type SkillSource,
  type ToolResult,
} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";
import {memoryStore} from "./helpers.js";
import {
  call,
  delegate,
  execute,
  final,
  forkingAgent,
  inherited,
  isFork,
  PREAMBLE,
  resultOf,
  toolNames,
} from "./fork-fixtures.js";

const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "page";
  },
});

void test("a fork starts from the parent's latest request, followed by the task", async () => {
  const forkRequests: ModelRequest[] = [];
  const leadRequests: ModelRequest[] = [];
  const lead = forkingAgent({
    tools: {read},
    script(request) {
      if (isFork(request)) {
        forkRequests.push(request);
        return final("fork done");
      }
      leadRequests.push(request);
      if (request.step === 1) return call("r1", "read");
      if (request.step === 2) return delegate("d1", "Summarize the page");
      return final("Done");
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Done");

  const [fork] = forkRequests;
  assert.ok(fork);
  // The inherited messages are those of the request that chose to delegate, so the
  // delegating step's own call never appears without its result.
  const inheritedMessages = fork.messages.slice(0, -1);
  assert.deepEqual(inheritedMessages, leadRequests[1]!.messages);
  assert.equal(
    fork.messages.some(
      (m) => m.role === "assistant" && m.calls?.some((c) => c.name === "delegate"),
    ),
    false,
  );
  const task = fork.messages.at(-1);
  assert.ok(task?.role === "user" && task.content.endsWith("Task:\nSummarize the page"));
  // Same instructions and tools as the parent, so a provider can reuse its cached prefix.
  assert.equal(fork.instructions, leadRequests[1]!.instructions);
  assert.deepEqual(toolNames(fork), toolNames(leadRequests[1]!));
  assert.deepEqual(resultOf(result.messages, "d1"), {status: "success", output: "fork done"});
});

void test("a fork cannot fork again", async () => {
  let nested: ToolResult | undefined;
  const lead = forkingAgent({
    tools: {read},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return delegate("d2", "Go deeper");
        nested = resultOf(request.messages, "d2");
        return final("did it myself");
      }
      if (request.step === 1) return delegate("d1", "Subtask");
      return final("Done");
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(nested?.status, "error");
  assert.equal(nested.code, "fork_nested");
});

void test("without fork, a sub-agent starts with only the task", async () => {
  let seen: ModelRequest | undefined;
  const worker = agent({
    *model(request) {
      seen = request;
      return final("worked");
    },
  });
  const lead = agent({
    tools: {read, delegate: agentTool(worker, {description: "Delegate"})},
    *model(request) {
      if (request.step === 1) return call("r1", "read");
      if (request.step === 2) return delegate("d1", "Subtask");
      return final("Done");
    },
  });
  await execute(lead.run("Go"));
  assert.deepEqual(seen?.messages, [{role: "user", content: "Subtask"}]);
});

void test("a fork of a structured-output agent replies in plain text", async () => {
  const forkSteps: ModelRequest[] = [];
  let delegating: ModelRequest | undefined;
  const lead = forkingAgent({
    output: z.object({answer: z.string()}),
    tools: {read},
    script(request) {
      if (isFork(request)) {
        forkSteps.push(structuredClone(request));
        return final("The page says hello.");
      }
      if (request.step === 1) {
        delegating = structuredClone(request);
        return delegate("d1", "Read the page");
      }
      return final(JSON.stringify({answer: "Done"}));
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  // The run's own answer still matches the schema.
  assert.deepEqual(result.output, {answer: "Done"});
  assert.ok(delegating!.outputSchema);
  // The fork's reply is a tool result for the parent, so it asks for no schema
  // and accepts the plain reply in one step.
  assert.equal(forkSteps.length, 1);
  assert.equal(forkSteps[0]!.outputSchema, undefined);
  assert.deepEqual(resultOf(result.messages, "d1"), {
    status: "success",
    output: "The page says hello.",
  });
});

void test("a fork saves nothing to the parent's conversation", async () => {
  const conversation = new Conversation({store: memoryStore().store});
  let secondTurn: ModelRequest | undefined;
  let turn = 1;
  const lead = forkingAgent({
    tools: {read},
    script(request) {
      if (isFork(request)) {
        if (request.step === 1) return call("f1", "read");
        return final("fork done");
      }
      if (turn === 2) {
        secondTurn = structuredClone(request);
        return final("Hello again");
      }
      if (request.step === 1) return delegate("d1", "Read the page");
      return final("Done");
    },
  });
  assert.equal((await execute(lead.run("Go", {conversation}))).status, "completed");
  turn = 2;
  assert.equal((await execute(lead.run("Again", {conversation}))).status, "completed");
  const saved = secondTurn!.messages;
  // Only the parent's own exchange is saved: the delegate call and its result.
  assert.deepEqual(resultOf(saved, "d1"), {status: "success", output: "fork done"});
  assert.equal(resultOf(saved, "f1"), undefined);
  assert.equal(JSON.stringify(saved).includes(PREAMBLE), false);
});

void test("a fork's usage counts toward the parent run", async () => {
  const usage = {inputTokens: 100, outputTokens: 10};
  const lead = forkingAgent({
    tools: {read},
    script(request): ModelResponse {
      if (isFork(request))
        return {
          ...final("fork done"),
          usage: {inputTokens: 300, outputTokens: 20, cachedInputTokens: 250},
        };
      if (request.step === 1) return {...delegate("d1", "Subtask"), usage};
      return {...final("Done"), usage};
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(result.usage.inputTokens, 500);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.usage.cachedInputTokens, 250);
});

void test("a fork skips the root's beforeRun and afterRun", async () => {
  const checked: string[] = [];
  const reviewed: unknown[] = [];
  const lead = forkingAgent({
    tools: {read},
    *beforeRun(messages) {
      const input = messages.at(-1);
      if (input?.role === "user") checked.push(input.content);
    },
    *afterRun(candidate) {
      reviewed.push(candidate.output);
    },
    script(request) {
      if (isFork(request)) return final("fork done");
      if (request.step === 1) return delegate("d1", "Subtask");
      return final("Done");
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  // A fork's input and answer are a tool call of the parent run and its result.
  assert.deepEqual(checked, ["Go"]);
  assert.deepEqual(reviewed, ["Done"]);
  assert.deepEqual(resultOf(result.messages, "d1"), {status: "success", output: "fork done"});
});

void test("a fork keeps the skills the parent listed instead of listing them again", async () => {
  let lists = 0;
  const source = skills([
    {name: "pdf-forms", description: "Fill in PDF forms.", instructions: "List the fields first."},
  ]);
  const counted: SkillSource = {
    async list(options) {
      lists++;
      return source.list(options);
    },
    load: (skill, options) => source.load(skill, options),
  };
  let delegating: ModelRequest | undefined;
  let fork: ModelRequest | undefined;
  const lead = forkingAgent({
    instructions: "Help with documents.",
    skills: counted,
    script(request) {
      if (isFork(request)) {
        fork = structuredClone(request);
        return final("fork done");
      }
      if (request.step === 1) {
        delegating = structuredClone(request);
        return delegate("d1", "Fill in the form");
      }
      return final("Done");
    },
  });
  const {output} = await runHandler((ctx) => r.execute(ctx, lead.run("Go")));
  assert.equal(output.status, "completed");
  assert.equal(lists, 1);
  assert.equal(fork!.instructions, delegating!.instructions);
  assert.match(fork!.instructions ?? "", /pdf-forms/);
  assert.deepEqual(toolNames(fork!), toolNames(delegating!));
});

// --- Context compaction ----------------------------------------------------

// Each read adds about 243 estimated tokens, the tools about 235, and the fork's
// preamble about 108, so these settings put a threshold between the parent's
// third request and the fork's first.
const pages = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "x".repeat(400);
  },
});
const compactionNote = (messages: readonly Message[]) => {
  const first = messages[0];
  if (first?.role !== "user" || !first.content.startsWith("{")) return undefined;
  const parsed = JSON.parse(first.content) as {type?: string; request?: string};
  return parsed.type === "context-compacted" ? parsed : undefined;
};

void test("a fork of a compacted run starts from the note and the retained messages", async () => {
  let delegating: ModelRequest | undefined;
  let fork: ModelRequest | undefined;
  const lead = forkingAgent({
    tools: {pages},
    codeMode: false,
    toolResults: false,
    compaction: {
      maxTokens: 700,
      retainTokens: 260,
      *model() {
        return final("Read two pages of x.");
      },
    },
    script(request) {
      if (isFork(request)) {
        fork ??= structuredClone(request);
        return final("fork done");
      }
      if ((request.step ?? 1) <= 2) return call(`r${request.step}`, "pages");
      if (request.step === 3) {
        delegating = structuredClone(request);
        return delegate("d1", "Summarize the pages");
      }
      return final("Done");
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.ok(compactionNote(delegating!.messages), "the parent compacted before delegating");
  assert.deepEqual(inherited(fork!), delegating!.messages);
});

void test("a fork whose inherited view crosses the compaction threshold summarizes it first", async () => {
  let delegating: ModelRequest | undefined;
  let fork: ModelRequest | undefined;
  const notes: string[] = [];
  const progress: ProgressEvent[] = [];
  const lead = forkingAgent({
    tools: {pages},
    codeMode: false,
    toolResults: false,
    compaction: {
      maxTokens: 800,
      retainTokens: 300,
      *model(request) {
        notes.push(request.messages.map((m) => (m.role === "user" ? m.content : "")).join(""));
        return final("Read two pages of x.");
      },
    },
    script(request) {
      if (isFork(request)) {
        fork ??= structuredClone(request);
        return final("fork done");
      }
      if ((request.step ?? 1) <= 2) return call(`r${request.step}`, "pages");
      if (request.step === 3) {
        delegating = structuredClone(request);
        return delegate("d1", "Summarize the pages");
      }
      return final("Done");
    },
  });
  const result = await execute(
    lead.run("Go", {
      *onProgress(event) {
        progress.push(event);
      },
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(compactionNote(delegating!.messages), undefined);
  // The fork pays for a summary before its first request, and that request no
  // longer starts with the parent's messages, so the parent's cache does not apply.
  assert.equal(notes.length, 1);
  assert.ok(
    progress.some(
      (event) =>
        event.type === "tool-progress" &&
        event.callId === "d1" &&
        (event.value as {type?: string}).type === "compaction",
    ),
  );
  // Everything the fork inherited became the note; only the fork's own input
  // stays verbatim. The parent's request is not the fork's input, so unlike a
  // compaction in the parent, the note does not quote it: it survives only as
  // far as the summary kept it.
  assert.ok(compactionNote(fork!.messages));
  assert.equal(fork!.messages.length, 2);
  assert.match((fork!.messages[1] as {content: string}).content, /Task:\nSummarize the pages$/);
  assert.equal(
    fork!.messages.some((m) => m.role === "user" && m.content === "Go"),
    false,
  );
  assert.equal(compactionNote(fork!.messages)!.request, undefined);
});

void test("a fork sizes its view from the input tokens the model reported to the parent", async () => {
  const progress: ProgressEvent[] = [];
  // The model reports 300 input tokens; an estimate of the same view is about 726,
  // past maxTokens. The parent trusts the report, and so must its fork.
  const usage = {inputTokens: 300, outputTokens: 5};
  let fork: ModelRequest | undefined;
  const lead = forkingAgent({
    tools: {pages},
    codeMode: false,
    toolResults: false,
    compaction: {
      maxTokens: 700,
      retainTokens: 260,
      *model() {
        return final("Read two pages of x.");
      },
    },
    script(request): ModelResponse {
      if (isFork(request)) {
        fork ??= structuredClone(request);
        return {...final("fork done"), usage};
      }
      if ((request.step ?? 1) <= 2) return {...call(`r${request.step}`, "pages"), usage};
      if (request.step === 3) return {...delegate("d1", "Summarize the pages"), usage};
      return {...final("Done"), usage};
    },
  });
  const result = await execute(
    lead.run("Go", {
      *onProgress(event) {
        progress.push(event);
      },
    }),
  );
  assert.equal(result.status, "completed");
  const compactions = progress.filter(
    (event) =>
      event.type === "compaction" ||
      (event.type === "tool-progress" && (event.value as {type?: string}).type === "compaction"),
  );
  assert.deepEqual(compactions, []);
  assert.equal(compactionNote(fork!.messages), undefined);
});

// --- beforeStep hooks ------------------------------------------------------

void test("a beforeStep addition reaches a fork once", async () => {
  const reminder = "Reminder: answer in English.";
  let delegating: ModelRequest | undefined;
  let fork: ModelRequest | undefined;
  const lead = forkingAgent({
    tools: {read},
    *beforeStep(request) {
      return {messages: [{role: "user", content: reminder}, ...request.messages]};
    },
    script(request) {
      if (isFork(request)) {
        fork = structuredClone(request);
        return final("fork done");
      }
      if (request.step === 1) return call("r1", "read");
      if (request.step === 2) {
        delegating = structuredClone(request);
        return delegate("d1", "Summarize the page");
      }
      return final("Done");
    },
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  const reminders = (request: ModelRequest) =>
    request.messages.filter((m) => m.role === "user" && m.content === reminder).length;
  assert.equal(reminders(delegating!), 1);
  // The fork starts from the history before the hook; its own run of the hook adds it.
  assert.equal(reminders(fork!), 1);
  assert.deepEqual(fork!.messages.slice(0, -1), delegating!.messages);
});

// --- Provider prompt cache -------------------------------------------------

type Body = Record<string, any>;
const lookup = tool({
  description: "Look up an order",
  input: z.object({id: z.string()}),
  *execute({id}) {
    return {id, status: "shipped"};
  },
});

void test("on Anthropic, a fork's request repeats the parent's request block for block before the task", async () => {
  const bodies: Body[] = [];
  const isForkBody = (body: Body) => JSON.stringify(body.messages).includes(PREAMBLE);
  const replies = (body: Body) => body.messages.filter((m: Body) => m.role === "assistant").length;
  const reply = (body: Body) => {
    let content: Body[];
    if (isForkBody(body)) content = [{type: "text", text: "Order 8 has shipped."}];
    else if (replies(body) === 0)
      content = [{type: "tool_use", id: "t1", name: "lookup", input: {id: "7"}}];
    else if (replies(body) === 1)
      content = [{type: "tool_use", id: "t2", name: "delegate", input: {task: "Check order 8"}}];
    else content = [{type: "text", text: "Both shipped."}];
    return {
      id: `msg_${bodies.length}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content,
      stop_reason: content[0]!.type === "tool_use" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {input_tokens: 10, output_tokens: 5},
    };
  };
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as Body;
    bodies.push(body);
    return Response.json(reply(body));
  };
  const model = aiModel({
    model: createAnthropic({apiKey: "test-only", fetch: fetch as typeof globalThis.fetch})(
      "claude-sonnet-4-5",
    ),
  });
  const lead = forkingAgent({instructions: "Answer order questions.", tools: {lookup}, model});
  const {output} = await runHandler((ctx) => r.execute(ctx, lead.run("Where are 7 and 8?")));
  assert.equal(output.status, "completed");

  const parent = bodies.find((body) => !isForkBody(body) && replies(body) === 1)!;
  const fork = bodies.find(isForkBody)!;
  // A cache point is a request position, not part of the cached content.
  const strip = (part: Body) => {
    const {cache_control: _, ...rest} = part;
    return rest;
  };
  const blocks = (body: Body) =>
    (body.messages as Body[]).flatMap((message) =>
      (typeof message.content === "string"
        ? [{type: "text", text: message.content}]
        : (message.content as Body[])
      ).map((part) => ({role: message.role, ...strip(part)})),
    );
  assert.deepEqual(fork.system, parent.system);
  assert.deepEqual(fork.tools, parent.tools);
  const prefix = blocks(parent);
  assert.deepEqual(blocks(fork).slice(0, prefix.length), prefix);
  assert.equal(blocks(fork).length, prefix.length + 1);
  // The fork's newest block carries a cache point one block past the parent's,
  // well within the provider's lookback for the parent's cached prefix.
  const last = (fork.messages as Body[]).at(-1)!;
  assert.ok((last.content as Body[]).at(-1)!.cache_control);
});
