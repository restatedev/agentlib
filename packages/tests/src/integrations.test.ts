import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {agent, type ModelResponse} from "@restate-agents/core";
import {restateTools} from "@restate-agents/core/discovery";
import {webSearch} from "@restate-agents/core/web-search";
import {runHandler} from "./replay-harness.mjs";
const final: ModelResponse = {type: "final", text: "done"};

void test("discovered tool names are data, including JavaScript prototype property names", async () => {
  const names = ["__proto__", "constructor", "toString"];
  const response = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const catalog = yield* restateTools({
          adminUrl: "https://fixture.test",
          fetch: async () =>
            Response.json({
              services: [
                {
                  name: "Tools",
                  ty: "Service",
                  handlers: names.map((name) => ({
                    name,
                    metadata: {"restate.dev/agent": name},
                  })),
                },
              ],
            }),
        });
        assert.equal(Object.getPrototypeOf(catalog.tools), Object.prototype);
        assert.ok(Object.hasOwn(catalog.tools, "__proto__"));
        return Object.keys(catalog.tools).sort();
      })(),
    ),
  );
  assert.deepEqual(response.output, [...names].sort());
});

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
        assert.deepEqual(found.targets, {
          read: {service: "Allowed", handler: "read", keyed: true, acceptsInput: true},
        });
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

void test("web search accepts a description and display override", () => {
  const search = webSearch({description: "Search docs.", describe: {name: "Searched"}});
  assert.equal(search.description, "Search docs.");
  assert.deepEqual(search.info, {name: "Searched"});
});

void test("web search without an API key uses keyless access", async () => {
  const search = webSearch({
    fetch: async (_, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), null);
      assert.equal(headers.get("X-Tavily-Access-Mode"), "keyless");
      return Response.json({results: [{title: "t", url: "https://example.test", content: "c"}]});
    },
  });
  const a = agent({
    tools: {search},
    *model(req) {
      if (req.messages.some((m) => m.role === "tool")) return final;
      return {type: "tool_calls", calls: [{id: "s", name: "search", input: {query: "fact"}}]};
    },
  });
  const {output} = await runHandler((ctx: Context) => r.execute(ctx, a.run("go")));
  assert.match(JSON.stringify(output.messages), /example\.test/);
});

void test("web search bounds results, drops malformed items, and replays without HTTP", async () => {
  let requests = 0;
  const search = webSearch({
    apiKey: "private-key",
    fetch: async (_, init) => {
      requests++;
      assert.ok(init?.signal);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-key");
      return new Response(
        JSON.stringify({
          results: [
            {title: "broken", url: "not a url", content: "x"},
            ...Array.from({length: 8}, () => ({
              title: "source",
              url: "https://example.test/source",
              content: "x".repeat(5000),
            })),
          ],
        }),
        {headers: {"Content-Type": "application/json"}},
      );
    },
  });
  const a = agent({
    tools: {search},
    *model(req) {
      assert.ok(!JSON.stringify(req).includes("private-key"));
      if (req.messages.some((m) => m.role === "tool")) return final;
      return {
        type: "tool_calls",
        calls: [{id: "search", name: "search", input: {query: "public fact"}}],
      };
    },
  });
  const handler = (ctx: Context) => r.execute(ctx, a.run("go"));
  const first = await runHandler(handler);
  const result = first.output.messages.find((m: {role: string}) => m.role === "tool").result.output;
  assert.equal(result.length, 5);
  // The malformed item is dropped instead of failing the search.
  assert.ok(result.every((item: {title: string}) => item.title === "source"));
  assert.equal(result[0].content.length, 4000);
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(requests, 1);
});
