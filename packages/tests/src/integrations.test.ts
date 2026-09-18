import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {agent, type ModelResponse} from "@restate-agents/core";
import {restateTools} from "@restate-agents/core/discovery";
import {webSearch} from "@restate-agents/core/web-search";
import {otelUpdates} from "@restate-agents/core/telemetry";
import {runHandler} from "./replay-harness.mjs";
const final: ModelResponse = {type: "final", text: "done"};

void test("Restate discovery filters permissions, rewrites nested refs, and snapshots catalogs", async () => {
  let requests = 0;
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const found = yield* restateTools({
          adminUrl: "https://fixture.test",
          allow: (target) => target.service === "Allowed",
          fetch: async () => {
            requests++;
            return new Response(
              JSON.stringify({
                services: [
                  {
                    name: "Allowed",
                    ty: "VirtualObject",
                    handlers: [
                      {
                        name: "read",
                        metadata: {"restate.dev/agent": "read"},
                        input_json_schema: {
                          type: "object",
                          properties: {id: {$ref: "#/$defs/Id"}},
                          $defs: {Id: {type: "string"}},
                        },
                      },
                    ],
                  },
                  {
                    name: "Forbidden",
                    ty: "Service",
                    handlers: [{name: "secret", metadata: {"restate.dev/agent": "secret"}}],
                  },
                ],
              }),
              {headers: {"Content-Type": "application/json"}},
            );
          },
        });
        assert.deepEqual(Object.keys(found.tools), ["read"]);
        const schema = found.tools.read.inputSchema;
        assert.match(JSON.stringify(schema), /key/);
        assert.match(JSON.stringify(schema), /id/);
        return Object.keys(found.tools);
      })(),
    );
  const first = await runHandler(handler);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(requests, 1);
});

void test("web search bounds results, forwards cancellation, and replays without HTTP", async () => {
  let requests = 0;
  const search = webSearch({
    apiKey: "private-key",
    fetch: async (_, init) => {
      requests++;
      assert.ok(init?.signal);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-key");
      return new Response(
        JSON.stringify({
          results: Array.from({length: 8}, () => ({
            title: "source",
            url: "https://example.test/source",
            content: "x".repeat(5000),
          })),
        }),
        {headers: {"Content-Type": "application/json"}},
      );
    },
  });
  const a = agent({
    tools: {search},
    *model(req) {
      assert.ok(!JSON.stringify(req).includes("private-key"));
      return req.messages.some((m) => m.role === "tool")
        ? final
        : {
            type: "tool_calls",
            calls: [{id: "search", name: "search", input: {query: "public fact"}}],
          };
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("go"));
  const first = await runHandler(handler);
  const result = first.output.messages.find((m: {role: string}) => m.role === "tool").result.output;
  assert.equal(result.length, 5);
  assert.equal(result[0].content.length, 4000);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(requests, 1);
});

void test("OTel hooks emit metadata once per journaled effect and omit private context", async () => {
  const spans: unknown[] = [];
  const tracer = {
    startSpan(name: string, options: unknown) {
      spans.push({name, options});
      return {end() {}};
    },
  };
  const a = agent<{secret: string}>({
    *model() {
      return final;
    },
    onUpdate: otelUpdates(tracer as Parameters<typeof otelUpdates>[0]),
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("go", {context: {secret: "private"}}));
  const first = await runHandler(handler);
  assert.equal(spans.length, 2);
  assert.ok(!JSON.stringify(spans).includes("private"));
  await runHandler(handler, {replay: first.journal});
  assert.equal(spans.length, 2);
});
