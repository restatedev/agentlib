import assert from "node:assert/strict";
import {test} from "node:test";
import OpenAI from "openai";
import {execute} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, tool} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {runHandler} from "./replay-harness.mjs";

void test(
  "OpenAI adapter renders the protocol and replays without HTTP",
  {timeout: 5000},
  async () => {
    const requests: Record<string, any>[] = [];
    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        assert.ok(init?.signal);
        assert.ok(typeof init.body === "string");
        const request = JSON.parse(init.body);
        requests.push(request);
        const first = requests.length === 1;
        return Response.json({
          id: "test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              finish_reason: first ? "tool_calls" : "stop",
              message: first
                ? {
                    role: "assistant",
                    content: "Looking it up",
                    tool_calls: [
                      {
                        id: "one",
                        type: "function",
                        function: {name: "lookup", arguments: '{"id":"123"}'},
                      },
                    ],
                  }
                : {role: "assistant", content: "Found 123"},
            },
          ],
        });
      },
    });
    const a = agent({
      instructions: "Help with tickets",
      model: openAIModel({client, model: "test-model", settings: {temperature: 0}}),
      tools: {
        lookup: tool({
          description: "Look up a ticket",
          input: z.object({id: z.string()}),
          *execute({id}) {
            return {id};
          },
        }),
      },
    });
    const handler = (ctx: Parameters<typeof execute>[0]) => execute(ctx, a.run("Find ticket 123"));
    const live = await runHandler(handler);
    assert.equal(live.output.output, "Found 123");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.model, "test-model");
    assert.equal(requests[0]!.temperature, 0);
    assert.equal(requests[0]!.tools[0].function.name, "lookup");
    assert.deepEqual(requests[1]!.messages, [
      {role: "system", content: "Help with tickets"},
      {role: "user", content: "Find ticket 123"},
      {
        role: "assistant",
        content: "Looking it up",
        tool_calls: [
          {id: "one", type: "function", function: {name: "lookup", arguments: '{"id":"123"}'}},
        ],
      },
      {role: "tool", tool_call_id: "one", content: '{"status":"success","output":{"id":"123"}}'},
    ]);
    const replay = await runHandler(handler, {replay: live.journal});
    assert.deepEqual(replay.output, live.output);
    assert.equal(requests.length, 2);
  },
);

void test("defining the optional adapter does not require credentials", () => {
  assert.equal(typeof openAIModel({model: "test-model"}), "function");
});

void test("GPT-5.6 tools use a compatible reasoning default without overriding explicit settings", async () => {
  for (const fixture of [
    {model: "gpt-5.6-luna", tools: true, expected: "none"},
    {model: "gpt-5.6-luna-2026-07-09", tools: true, expected: "none"},
    {model: "gpt-5.6-luna", tools: false, expected: undefined},
    {model: "test-model", tools: true, expected: undefined},
    {model: "gpt-5.6-luna", tools: true, explicit: "low" as const, expected: "low"},
  ]) {
    let requests = 0;
    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        assert.equal(typeof init?.body, "string");
        const body = JSON.parse(init!.body as string);
        assert.equal(body.reasoning_effort, fixture.expected);
        requests++;
        return Response.json({choices: [{finish_reason: "stop", message: {content: "ready"}}]});
      },
    });
    const model = openAIModel({
      client,
      model: fixture.model,
      settings: {reasoning_effort: fixture.explicit},
    });
    await runHandler((ctx) =>
      execute(
        ctx,
        model({
          messages: [{role: "user", content: "hello"}],
          tools: fixture.tools
            ? [{name: "lookup", description: "lookup", inputSchema: {type: "object"}}]
            : [],
        }),
      ),
    );
    assert.equal(requests, 1);
  }
});

void test("permanent OpenAI errors fail once and replay without HTTP", async () => {
  let requests = 0;
  const client = new OpenAI({
    apiKey: "test-only",
    fetch: async () => {
      requests++;
      return Response.json(
        {error: {message: "Function tools with reasoning_effort are not supported"}},
        {status: 400},
      );
    },
  });
  const a = agent({model: openAIModel({client, model: "gpt-5.6-luna"})});
  const handler = async (ctx: Parameters<typeof execute>[0]) => {
    try {
      return await execute(ctx, a.run("hello"));
    } catch (error) {
      return {error: String(error)};
    }
  };
  const live = await runHandler(handler);
  assert.match(live.output.error, /Function tools/);
  assert.equal(requests, 1);
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(requests, 1);
});

void test(
  "malformed or truncated model responses never execute a tool",
  {timeout: 5000},
  async () => {
    const validCall = {id: "one", type: "function", function: {name: "write", arguments: "{}"}};
    const cases = [
      {choices: []},
      {
        choices: [
          {finish_reason: "length", message: {content: "Partial", tool_calls: [validCall]}},
        ],
      },
      {choices: [{finish_reason: "content_filter", message: {content: "Partial"}}]},
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {tool_calls: [{...validCall, function: {name: "write", arguments: "{"}}]},
          },
        ],
      },
      {choices: [{finish_reason: "tool_calls", message: {tool_calls: []}}]},
      {
        choices: [
          {finish_reason: "tool_calls", message: {tool_calls: [{type: "custom", id: "one"}]}},
        ],
      },
      {choices: [{finish_reason: "stop", message: {refusal: "Cannot help"}}]},
      {choices: [{finish_reason: "stop", message: {content: ""}}]},
    ];
    let writes = 0;
    for (const response of cases) {
      let requests = 0;
      const client = new OpenAI({
        apiKey: "test-only",
        fetch: async () => {
          requests++;
          return Response.json({
            id: "test",
            object: "chat.completion",
            created: 0,
            model: "test",
            ...response,
          });
        },
      });
      const a = agent({
        model: openAIModel({client, model: "test"}),
        tools: {
          write: tool({
            description: "Write",
            input: z.object({}),
            *execute() {
              writes++;
              return null;
            },
          }),
        },
      });
      const handler = async (ctx: Parameters<typeof execute>[0]) => {
        try {
          return await execute(ctx, a.run("Write"));
        } catch (error) {
          return {error: error instanceof Error ? error.message : String(error)};
        }
      };
      const live = await runHandler(handler);
      assert.equal(typeof live.output.error, "string");
      assert.equal(
        requests,
        1,
        "invalid model output should be a terminal error, not a provider retry",
      );
      const replay = await runHandler(handler, {replay: live.journal});
      assert.deepEqual(replay.output, live.output);
      assert.equal(requests, 1);
    }
    assert.equal(writes, 0);
  },
);
