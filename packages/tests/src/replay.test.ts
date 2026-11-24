import assert from "node:assert/strict";
import {test} from "node:test";
import {execute, run} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  journaledModel,
  LazyStateConversation,
  tool,
  type ModelRequest,
  type ModelResponse,
} from "@restatedev/agentlib";
import {memoryStore} from "./helpers.js";
import {runHandler, runNames} from "./replay-harness.mjs";

void test("model and tool effects are reused on journal replay", {timeout: 5000}, async () => {
  const effects = {models: 0, tools: 0};
  const a = agent({
    model: journaledModel(async (request, {signal}): Promise<ModelResponse> => {
      assert.ok(signal instanceof AbortSignal);
      effects.models++;
      if (request.messages.length === 1) {
        return {type: "tool_calls", calls: [{id: "one", name: "lookup", input: {}}]};
      }
      return {type: "final", text: "Found it"};
    }),
    tools: {
      lookup: tool({
        description: "Lookup",
        input: z.object({}),
        *execute() {
          return yield* run(
            async () => {
              effects.tools++;
              return {value: 42};
            },
            {name: "lookup"},
          );
        },
      }),
    },
  });
  const handler = (ctx: Parameters<typeof execute>[0]) => execute(ctx, a.run("Find it"));
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.deepEqual(effects, {models: 2, tools: 1});
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.deepEqual(effects, {models: 2, tools: 1});
});

void test(
  "partial replay resumes after a completed tool without repeating it",
  {
    timeout: 5000,
  },
  async () => {
    let tools = 0;
    let models = 0;
    const a = agent({
      model: journaledModel(async (request): Promise<ModelResponse> => {
        models++;
        if (request.messages.length === 1) {
          return {type: "tool_calls", calls: [{id: "one", name: "write", input: {}}]};
        }
        return {type: "final", text: "Saved"};
      }),
      tools: {
        write: tool({
          description: "Write",
          input: z.object({}),
          *execute() {
            return yield* run(
              async () => {
                tools++;
                return "saved";
              },
              {name: "write"},
            );
          },
        }),
      },
    });
    const handler = (ctx: Parameters<typeof execute>[0]) => execute(ctx, a.run("Save"));
    const live = await runHandler(handler);
    assert.equal(live.journal.length, 7); // Input + three run command/completion pairs.
    const resumed = await runHandler(handler, {replay: live.journal.slice(0, 5)});
    assert.deepEqual(resumed.output, live.output);
    assert.equal(tools, 1);
    assert.equal(models, 3); // Two original calls; only the unfinished final call repeats.
  },
);

void test("compaction and summary calls are journaled under their own names", async () => {
  const lastText = (request: ModelRequest) => {
    const last = request.messages.at(-1);
    return last?.role === "user" ? last.content : "";
  };
  let reads = 0;
  // One model serves every call, so each journal name comes from its request.
  const model = journaledModel(async (request): Promise<ModelResponse> => {
    if (lastText(request).includes('"type":"handoff-note-request"'))
      return {type: "final", text: "read some pages"};
    if (lastText(request).startsWith("The run stopped"))
      return {type: "final", text: "Stopped after reading"};
    return {type: "tool_calls", calls: [{id: `r${++reads}`, name: "read", input: {}}]};
  });
  const read = tool({
    description: "Read a page",
    input: z.object({}),
    *execute() {
      return "x".repeat(400);
    },
  });
  const earlier = Array.from({length: 10}, (_, i) => [
    {role: "user" as const, content: `question ${i}`},
    {role: "assistant" as const, content: `answer ${i}`},
  ]).flat();
  const handler = (ctx: Parameters<typeof execute>[0]) =>
    execute(
      ctx,
      (function* () {
        const {store} = memoryStore();
        const conversation = new LazyStateConversation({store});
        yield* conversation.append(earlier, 0);
        const a = agent({
          tools: {read},
          codeMode: false,
          maxSteps: 6,
          compaction: {maxTokens: 650, retainTokens: 300},
          model,
        });
        return yield* a.run("Go", {conversation});
      })(),
    );
  const live = await runHandler(handler);
  assert.equal(live.output.status, "stopped");
  assert.equal(live.output.output, "Stopped after reading");
  assert.deepEqual(
    [...new Set(runNames(live.journal))],
    ["Ask model", "Compact context", "Summarize stopped run"],
  );
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
});
