import assert from "node:assert/strict";
import {test} from "node:test";
import {execute, run} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, journaledModel, tool, type ModelResponse} from "@restate-agents/core";
import {runHandler} from "./replay-harness.mjs";

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
