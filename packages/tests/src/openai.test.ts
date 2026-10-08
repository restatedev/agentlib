import assert from "node:assert/strict";
import {test} from "node:test";
import OpenAI from "openai";
import type {ChatCompletionAssistantMessageParam} from "openai/resources/chat/completions";
import {execute, run, spawn} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, tool, type ToolManifest} from "@restate-agents/core";
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
        let message: ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: "Found 123",
        };
        if (first) {
          message = {
            role: "assistant",
            content: "Looking it up",
            tool_calls: [
              {
                id: "one",
                type: "function",
                function: {name: "lookup", arguments: '{"id":"123"}'},
              },
            ],
          };
        }
        return Response.json({
          id: "test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              finish_reason: first ? "tool_calls" : "stop",
              message,
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
    assert.equal(requests[0]!.tools[0].function.strict, true);
    assert.equal(requests[0]!.tools[0].function.parameters.additionalProperties, false);
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
    const tools: ToolManifest[] = [];
    if (fixture.tools)
      tools.push({name: "lookup", description: "lookup", inputSchema: {type: "object"}});
    await runHandler((ctx) =>
      execute(
        ctx,
        model({
          messages: [{role: "user", content: "hello"}],
          tools,
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

void test("interrupting a run aborts the model request in flight", async () => {
  let started!: () => void;
  const requested = new Promise<void>((resolve) => (started = resolve));
  let aborted = false;
  const client = new OpenAI({
    apiKey: "test-only",
    maxRetries: 0,
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Fail rather than hang when the request is never aborted.
        const timer = setTimeout(() => reject(new Error("request was not aborted")), 2000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted = true;
          reject(init.signal!.reason);
        });
        started();
      }),
  });
  const a = agent({model: openAIModel({client, model: "test"}), finalize: false});
  const {output} = await runHandler((ctx) =>
    execute(
      ctx,
      (function* () {
        // A journaled step stands in for the user: it interrupts once the request is out.
        const interrupt = spawn(run(async () => (await requested, "Stop"), {name: "user"}));
        const result = yield* a.run("hello", {controls: {interrupt}});
        return result.status;
      })(),
    ),
  );
  assert.equal(output, "interrupted");
  assert.equal(aborted, true);
});

void test("throttled, conflicting and server-side OpenAI errors stay retryable", async () => {
  for (const status of [408, 409, 429, 500, 503]) {
    let requests = 0;
    const client = new OpenAI({
      apiKey: "test-only",
      // Restate owns retries; the client must not hide one.
      maxRetries: 0,
      fetch: async () => {
        requests++;
        return Response.json({error: {message: `failed with ${status}`}}, {status});
      },
    });
    const a = agent({model: openAIModel({client, model: "test"})});
    // The harness surfaces a retryable failure instead of retrying it.
    await assert.rejects(
      runHandler((ctx) => execute(ctx, a.run("hello"))),
      new RegExp(`SDK failure.*failed with ${status}`),
    );
    assert.equal(requests, 1, `status ${status}`);
  }
});

void test(
  "malformed or truncated model responses never execute a tool",
  {timeout: 5000},
  async () => {
    const validCall = {id: "one", type: "function", function: {name: "write", arguments: "{}"}};
    // Each case fails its own protocol check, not some unrelated error.
    const cases: [Record<string, unknown>, RegExp][] = [
      [{choices: []}, /Incomplete model response: no choices/],
      [
        {
          choices: [
            {finish_reason: "length", message: {content: "Partial", tool_calls: [validCall]}},
          ],
        },
        /Incomplete model response: length/,
      ],
      [
        {choices: [{finish_reason: "content_filter", message: {content: "Partial"}}]},
        /Incomplete model response: content_filter/,
      ],
      [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {tool_calls: [{...validCall, function: {name: "write", arguments: "{"}}]},
            },
          ],
        },
        /Invalid JSON arguments for tool write/,
      ],
      [
        {choices: [{finish_reason: "tool_calls", message: {tool_calls: []}}]},
        /Model indicated tool calls but returned none/,
      ],
      [
        {
          choices: [
            {finish_reason: "tool_calls", message: {tool_calls: [{type: "custom", id: "one"}]}},
          ],
        },
        /Unsupported model tool-call type/,
      ],
      [
        {choices: [{finish_reason: "stop", message: {refusal: "Cannot help"}}]},
        /Model refused the request: Cannot help/,
      ],
      [
        {choices: [{finish_reason: "stop", message: {content: ""}}]},
        /Model returned an invalid response/,
      ],
    ];
    let writes = 0;
    for (const [response, expected] of cases) {
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
      assert.match(live.output.error, expected);
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
