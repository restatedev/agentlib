import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {restateTools} from "@restatedev/agentlib/discovery";
import {runHandler} from "./replay-harness.mjs";

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
