import assert from "node:assert/strict";
import {test} from "node:test";
import {createAnthropic} from "@ai-sdk/anthropic";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, tool} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";

// Anthropic's strict tools and structured output reject these keywords with a 400.
const REJECTED = /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|maxItems)"/;

void test("a default agent sends Anthropic tools that strict mode would reject as non-strict", async () => {
  const bodies: Record<string, any>[] = [];
  const anthropic = createAnthropic({
    apiKey: "test-only",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const first = bodies.length === 1;
      return Response.json({
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: first
          ? [{type: "tool_use", id: "t1", name: "pick", input: {count: 99}}]
          : [{type: "text", text: '{"total":3}'}],
        stop_reason: first ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {input_tokens: 10, output_tokens: 5},
      });
    }) as typeof globalThis.fetch,
  });
  let executed = 0;
  const a = agent({
    model: aiModel({model: anthropic("claude-sonnet-4-5")}),
    output: z.object({total: z.number().int().min(0).max(100)}),
    tools: {
      pick: tool({
        description: "Pick items",
        input: z.object({count: z.number().int().min(1).max(10)}),
        *execute({count}) {
          executed++;
          return count;
        },
      }),
    },
  });
  const {output} = await runHandler((ctx) => r.execute(ctx, a.run("Pick")));
  assert.equal(output.status, "completed");
  assert.equal(bodies.length, 2);
  const tools = bodies[0]!.tools as Record<string, any>[];
  // The default result-reading tool has integer bounds too.
  assert.ok(tools.some((t) => t.name !== "pick" && REJECTED.test(JSON.stringify(t.input_schema))));
  for (const t of tools) assert.equal(t.strict, undefined, t.name);
  // The AI SDK moves the output schema's bounds into its description.
  assert.doesNotMatch(JSON.stringify(bodies[0]!.output_config.format.schema), REJECTED);
  // The bounds still hold: the tool's schema rejects the call before it runs.
  assert.equal(executed, 0);
  const result = bodies[1]!.messages.at(-1).content[0];
  assert.equal(result.type, "tool_result");
  assert.match(result.content, /"code":"invalid_input".*too_big/s);
});
