import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {agent, searchToolsTool, type ModelResponse} from "@restate-agents/core";
import {mcpTools} from "@restate-agents/core/mcp";
import {runHandler} from "./replay-harness.mjs";

type Seen = {
  method: string;
  session: string | null;
  authorization: string | null;
  idempotency: string | null;
};
function fixture(
  protocol: "stateless" | "stateful",
  config: {unauthorized?: boolean; expired?: boolean; toolError?: boolean} = {},
) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const headers = req.headers;
    if (req.method === "GET") return new Response(null, {status: 405});
    if (req.method === "DELETE") {
      seen.push({
        method: "DELETE",
        session: headers.get("mcp-session-id"),
        authorization: headers.get("authorization"),
        idempotency: null,
      });
      return new Response(null, {status: 200});
    }
    const message = (await req.json()) as {
      id?: string;
      method: string;
      params: {arguments: {id: string}};
    };
    if (message.id === undefined) return new Response(null, {status: 202});
    seen.push({
      method: message.method,
      session: headers.get("mcp-session-id"),
      authorization: headers.get("authorization"),
      idempotency: headers.get("idempotency-key"),
    });
    if (config.unauthorized && headers.get("authorization") !== "Bearer new")
      return new Response(null, {status: 401});
    if (config.expired && message.method === "tools/call")
      return new Response("Session not found", {status: 404});
    let result: Record<string, unknown>;
    const out: Record<string, string> = {"Content-Type": "application/json"};
    if (message.method === "initialize") {
      out["mcp-session-id"] = "session-1";
      result = {
        protocolVersion: "2025-11-25",
        capabilities: {tools: {}},
        serverInfo: {name: "fixture", version: "1"},
      };
    } else if (message.method === "server/discover")
      result = {supportedVersions: ["2026-07-28"], capabilities: {tools: {}}};
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "lookup",
            description: "Find a record",
            inputSchema: {
              type: "object",
              properties: {id: {type: "string"}},
              required: ["id"],
              additionalProperties: false,
            },
          },
          {
            name: "forbidden",
            description: "Not permitted",
            inputSchema: {type: "object", properties: {}},
          },
        ],
      };
    else if (message.method === "tools/call") {
      result = {
        content: [{type: "text", text: `found ${message.params.arguments.id}`}],
      };
      if (config.toolError) result.isError = true;
      else result.structuredContent = {found: message.params.arguments.id};
    } else return new Response("Unknown method", {status: 400});
    if (protocol === "stateless")
      result = {...result, resultType: "complete", ttlMs: 60000, cacheScope: "private"};
    return new Response(JSON.stringify({jsonrpc: "2.0", id: message.id, result}), {headers: out});
  };
  return {fetch, seen};
}
for (const protocol of ["stateless", "stateful"] as const) {
  void test(`MCP ${protocol}: catalog, filtered tool, credentials, session, and replay`, async () => {
    const mock = fixture(protocol);
    const handler = (ctx: Context) =>
      r.execute(
        ctx,
        (function* () {
          const mcp = yield* mcpTools({
            url: "https://fixture.test/mcp",
            namespace: "remote",
            protocol,
            fetch: mock.fetch,
            allow: (name) => name === "lookup",
            *token() {
              return "secret";
            },
          });
          assert.deepEqual(Object.keys(mcp.tools), ["remote_lookup"]);
          try {
            const a = agent({
              tools: {searchTools: searchToolsTool(), ...mcp.tools},
              *model(req): r.Operation<ModelResponse> {
                if (!req.messages.some((m) => m.role === "tool"))
                  return {
                    type: "tool_calls",
                    calls: [{id: "s", name: "searchTools", input: {query: "remote lookup"}}],
                  };
                if (!req.messages.some((m) => m.role === "tool" && m.name === "remote_lookup")) {
                  assert.ok(req.tools.some((t) => t.name === "remote_lookup"));
                  return {
                    type: "tool_calls",
                    calls: [{id: "lookup-1", name: "remote_lookup", input: {id: "42"}}],
                  };
                }
                assert.match(JSON.stringify(req.messages), /found 42/);
                return {type: "final", text: "done"};
              },
            });
            return yield* a.run("find it");
          } finally {
            yield* mcp.close();
          }
        })(),
      );
    const first = await runHandler(handler);
    assert.equal(first.output.status, "completed");
    assert.equal(mock.seen.filter((x) => x.method === "tools/list").length, 1);
    assert.equal(mock.seen.filter((x) => x.method === "tools/call").length, 1);
    assert.ok(mock.seen.every((x) => x.authorization === "Bearer secret"));
    assert.match(
      mock.seen.find((x) => x.method === "tools/call")!.idempotency!,
      /:agent:lookup-1$/,
    );
    if (protocol === "stateful") {
      assert.equal(mock.seen.filter((x) => x.method === "initialize").length, 1);
      assert.equal(mock.seen.find((x) => x.method === "tools/call")!.session, "session-1");
      assert.equal(mock.seen.filter((x) => x.method === "DELETE").length, 1);
    } else {
      assert.equal(mock.seen.filter((x) => x.method === "initialize").length, 0);
      assert.equal(mock.seen.filter((x) => x.method === "server/discover").length, 1);
    }
    const requests = mock.seen.length;
    const replay = await runHandler(handler, {replay: first.journal});
    assert.deepEqual(replay.output, first.output);
    assert.equal(mock.seen.length, requests);
  });
}

void test("MCP authorization can refresh durably and is reused on replay", async () => {
  const mock = fixture("stateless", {unauthorized: true});
  let auth = 0;
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        let token = "old";
        const mcp = yield* mcpTools({
          url: "https://fixture.test/mcp",
          namespace: "remote",
          protocol: "stateless",
          fetch: mock.fetch,
          *token() {
            return token;
          },
          *onAuthorizationRequired() {
            token = yield* r.run(
              async () => {
                auth++;
                return "new";
              },
              {name: "refresh"},
            );
          },
        });
        return Object.keys(mcp.tools);
      })(),
    );
  const first = await runHandler(handler);
  assert.equal(auth, 1);
  assert.ok(mock.seen.some((r) => r.authorization === "Bearer old"));
  assert.ok(mock.seen.some((r) => r.authorization === "Bearer new"));
  const requests = mock.seen.length;
  const replay = await runHandler(handler, {replay: first.journal});
  assert.deepEqual(replay.output, first.output);
  assert.equal(auth, 1);
  assert.equal(mock.seen.length, requests);
});

void test("an expired stateful session fails instead of silently starting a replacement", async () => {
  const mock = fixture("stateful", {expired: true});
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const mcp = yield* mcpTools({
          url: "https://fixture.test/mcp",
          namespace: "remote",
          protocol: "stateful",
          fetch: mock.fetch,
        });
        try {
          return yield* agent({
            tools: mcp.tools,
            *model() {
              return {
                type: "tool_calls",
                calls: [{id: "x", name: "remote_lookup", input: {id: "42"}}],
              };
            },
          }).run("go");
        } catch (error) {
          return {error: String(error)};
        }
      })(),
    );
  const first = await runHandler(handler);
  assert.match(first.output.error, /404|Session not found/);
  assert.equal(mock.seen.filter((x) => x.method === "initialize").length, 1);
});
