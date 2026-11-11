import assert from "node:assert/strict";
import {test} from "node:test";
import {createOpenAI} from "@ai-sdk/openai";
import {execute, run, spawn} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, tool, type ModelUsage} from "@restatedev/agentlib";
import {aiModel} from "@restatedev/agentlib/provider";
import {runHandler} from "./replay-harness.mjs";

for (const api of ["chat", "responses"] as const) {
  void test(`OpenAI ${api} output strictness follows the schema and preserves explicit options`, async () => {
    const cases: {
      schema: z.ZodType;
      output: Record<string, unknown>;
      strict: boolean;
      override?: boolean;
    }[] = [
      {schema: z.object({answer: z.string().optional()}), output: {}, strict: false},
      {
        schema: z.object({labels: z.record(z.string(), z.string())}),
        output: {labels: {key: "value"}},
        strict: false,
      },
      {schema: z.object({answer: z.string().nullable()}), output: {answer: null}, strict: true},
      {
        schema: z.object({answer: z.string()}),
        output: {answer: "yes"},
        strict: false,
        override: false,
      },
    ];
    for (const fixture of cases) {
      const bodies: Record<string, any>[] = [];
      const openai = createOpenAI({
        apiKey: "test-only",
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(init!.body as string));
          const text = JSON.stringify(fixture.output);
          return Response.json(
            api === "chat"
              ? {
                  choices: [
                    {index: 0, finish_reason: "stop", message: {role: "assistant", content: text}},
                  ],
                }
              : {
                  output: [
                    {
                      id: "message",
                      type: "message",
                      role: "assistant",
                      content: [{type: "output_text", text, annotations: []}],
                    },
                  ],
                },
          );
        },
      });
      const a = agent({
        model: aiModel({
          model: openai[api]("test-model"),
          providerOptions: {
            openai: {
              store: false,
              ...(fixture.override === undefined ? {} : {strictJsonSchema: fixture.override}),
            },
          },
        }),
        output: fixture.schema,
      });
      const handler = (ctx: Parameters<typeof execute>[0]) => execute(ctx, a.run("Answer"));
      const live = await runHandler(handler);
      assert.deepEqual(live.output.output, fixture.output);
      assert.equal(bodies.length, 1);
      const format =
        api === "chat" ? bodies[0]!.response_format.json_schema : bodies[0]!.text.format;
      assert.equal(format.strict, fixture.strict);
      assert.equal(bodies[0]!.store, false);
      if (!fixture.strict && fixture.override === undefined)
        assert.deepEqual(format.schema, z.toJSONSchema(fixture.schema));
      const replay = await runHandler(handler, {replay: live.journal});
      assert.deepEqual(replay.output, live.output);
      assert.equal(bodies.length, 1);
    }
  });
}

void test("AI SDK OpenAI Responses handles tools, structured output and replay", async () => {
  const requests: Record<string, any>[] = [];
  const usages: (ModelUsage | undefined)[] = [];
  let lookups = 0;
  const openai = createOpenAI({
    apiKey: "test-only",
    fetch: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.ok(init?.signal);
      assert.equal(typeof init?.body, "string");
      requests.push(JSON.parse(init!.body as string));
      return Response.json({
        id: `response_${requests.length}`,
        model: "gpt-5.6-luna",
        output:
          requests.length === 1
            ? [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "one",
                  name: "lookup",
                  arguments: '{"id":"123"}',
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  content: [{type: "output_text", text: '{"answer":"Found 123"}', annotations: []}],
                },
              ],
        usage: {input_tokens: 120, output_tokens: 7, input_tokens_details: {cached_tokens: 100}},
      });
    },
  });
  const model = aiModel({model: openai("gpt-5.6-luna"), providerOptions: {openai: {store: false}}});
  const a = agent({
    instructions: "Help with tickets",
    *model(request) {
      const response = yield* model(request);
      usages.push(response.usage);
      return response;
    },
    maxOutputTokens: 512,
    output: z.object({answer: z.string()}),
    tools: {
      lookup: tool({
        description: "Look up a ticket",
        input: z.object({id: z.string()}),
        *execute({id}) {
          return yield* run(async function lookupTicket() {
            lookups++;
            return {id};
          });
        },
      }),
    },
  });
  const handler = (ctx: Parameters<typeof execute>[0]) => execute(ctx, a.run("Find ticket 123"));
  const live = await runHandler(handler);
  assert.deepEqual(live.output.output, {answer: "Found 123"});
  assert.deepEqual(usages, [
    {inputTokens: 120, outputTokens: 7, cachedInputTokens: 100},
    {inputTokens: 120, outputTokens: 7, cachedInputTokens: 100},
  ]);
  assert.equal(lookups, 1);
  assert.equal(requests.length, 2);
  const first = requests[0]!;
  assert.equal(first.store, false);
  assert.equal(first.max_output_tokens, 512);
  assert.equal(first.tools[0].name, "lookup");
  assert.equal(first.tools[0].strict, true);
  assert.equal(first.text.format.type, "json_schema");
  assert.deepEqual(first.text.format.schema.required, ["answer"]);
  assert.ok(
    first.input.some((item: Record<string, unknown>) => item.content === "Help with tickets"),
  );
  assert.ok(
    requests[1]!.input.some(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" &&
        item.call_id === "one" &&
        item.output === '{"status":"success","output":{"id":"123"}}',
    ),
  );
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(requests.length, 2);
  assert.equal(lookups, 1);
});

void test(
  "AI SDK OpenAI chat renders the protocol and replays without HTTP",
  {timeout: 5000},
  async () => {
    const requests: Record<string, any>[] = [];
    const client = createOpenAI({
      apiKey: "test-only",
      fetch: async (_url, init) => {
        assert.ok(init?.signal);
        assert.ok(typeof init.body === "string");
        const request = JSON.parse(init.body);
        requests.push(request);
        const first = requests.length === 1;
        let message: Record<string, unknown> = {
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
      model: aiModel({model: client.chat("test-model")}),
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

void test("defining an AI SDK model does not require credentials", () => {
  assert.equal(typeof aiModel({model: createOpenAI()("test-model")}), "function");
});

void test("permanent OpenAI errors fail once and replay without HTTP", async () => {
  let requests = 0;
  const client = createOpenAI({
    apiKey: "test-only",
    fetch: async () => {
      requests++;
      return Response.json(
        {error: {message: "Function tools with reasoning_effort are not supported"}},
        {status: 400},
      );
    },
  });
  const a = agent({model: aiModel({model: client.chat("gpt-5.6-luna")})});
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
  const client = createOpenAI({
    apiKey: "test-only",
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
  const a = agent({model: aiModel({model: client.chat("test")}), finalize: false});
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
    const client = createOpenAI({
      apiKey: "test-only",
      // Restate owns retries; the client must not hide one.
      fetch: async () => {
        requests++;
        return Response.json({error: {message: `failed with ${status}`}}, {status});
      },
    });
    const a = agent({model: aiModel({model: client.chat("test")})});
    // The harness surfaces a retryable failure instead of retrying it.
    await assert.rejects(
      runHandler((ctx) => execute(ctx, a.run("hello"))),
      new RegExp(`SDK failure.*failed with ${status}`),
    );
    assert.equal(requests, 1, `status ${status}`);
  }
});

void test("Restate waits as long as a throttled provider asks before retrying", async () => {
  const restateDefault = 50;
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toUTCString();
  const cases: {headers: Record<string, string>; delay: [number, number]}[] = [
    {headers: {"retry-after-ms": "1500.5"}, delay: [1501, 1501]},
    {headers: {"retry-after": "7"}, delay: [7000, 7000]},
    // Longer than the AI SDK would wait in process; Restate waits durably.
    {headers: {"retry-after": "120"}, delay: [120_000, 120_000]},
    // HTTP dates have whole seconds, so the wait is up to a second shorter.
    {headers: {"retry-after": inSeconds(30)}, delay: [28_000, 30_000]},
    {headers: {"retry-after-ms": "2000", "retry-after": "9"}, delay: [2000, 2000]},
    {headers: {"retry-after-ms": "soon", "retry-after": "3"}, delay: [3000, 3000]},
    // Unusable or missing headers keep Restate's own backoff.
    {headers: {"retry-after": inSeconds(-30)}, delay: [restateDefault, restateDefault]},
    {headers: {"retry-after": "later"}, delay: [restateDefault, restateDefault]},
    {headers: {}, delay: [restateDefault, restateDefault]},
  ];
  for (const {headers, delay} of cases) {
    let requests = 0;
    const client = createOpenAI({
      apiKey: "test-only",
      fetch: async () => {
        requests++;
        return Response.json({error: {message: "slow down"}}, {status: 429, headers});
      },
    });
    const a = agent({model: aiModel({model: client.chat("test")})});
    const failure = await runHandler((ctx) => execute(ctx, a.run("hello"))).then(
      () => assert.fail("expected a retryable failure"),
      (error: Error & {nextRetryDelay?: number}) => error,
    );
    assert.match(failure.message, /SDK failure.*slow down/);
    const [min, max] = delay;
    const actual = failure.nextRetryDelay ?? -1;
    assert.ok(min <= actual && actual <= max, `${JSON.stringify(headers)}: waited ${actual} ms`);
    assert.equal(requests, 1);
  }
});

void test("incomplete OpenAI chat responses never execute a tool", {timeout: 5000}, async () => {
  const validCall = {id: "one", type: "function", function: {name: "write", arguments: "{}"}};
  // Each case fails its own protocol check, not some unrelated error.
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      {
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: {content: "Partial", tool_calls: [validCall]},
          },
        ],
      },
      /Incomplete model response: length/,
    ],
    [
      {choices: [{index: 0, finish_reason: "content_filter", message: {content: "Partial"}}]},
      /Incomplete model response: content-filter/,
    ],
    [
      {choices: [{index: 0, finish_reason: "tool_calls", message: {tool_calls: []}}]},
      /Model indicated tool calls but returned none/,
    ],
    [
      {choices: [{index: 0, finish_reason: "stop", message: {content: ""}}]},
      /Model returned an invalid response/,
    ],
  ];
  let writes = 0;
  for (const [response, expected] of cases) {
    let requests = 0;
    const client = createOpenAI({
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
      model: aiModel({model: client.chat("test")}),
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
});
