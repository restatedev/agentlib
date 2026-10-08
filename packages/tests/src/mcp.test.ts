import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {agent, searchToolsTool, type Message, type ModelResponse} from "@restate-agents/core";
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
  config: {
    unauthorized?: boolean;
    expired?: boolean;
    toolError?: boolean;
    badSchema?: boolean;
    unavailable?: boolean;
    tooMany?: boolean;
    bigResult?: boolean;
    echo?: "result" | "error";
  } = {},
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
    if (config.unavailable && message.method === "tools/call")
      return new Response("Unavailable", {status: 503});
    if (config.echo === "error" && message.method === "tools/call")
      throw new Error(`upstream rejected ${headers.get("authorization")}`);
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
          ...(config.badSchema
            ? [
                {
                  name: "broken",
                  description: "Dangling reference",
                  inputSchema: {type: "object", properties: {x: {$ref: "#/definitions/missing"}}},
                },
              ]
            : []),
          ...(config.tooMany
            ? Array.from({length: 127}, (_, i) => ({
                name: `extra${i}`,
                description: "Filler",
                inputSchema: {type: "object", properties: {}},
              }))
            : []),
        ],
      };
    else if (message.method === "tools/call") {
      let found = `found ${message.params.arguments.id}`;
      if (config.echo === "result") found = `found with ${headers.get("authorization")}`;
      if (config.bigResult) found = "x".repeat(130000);
      result = {content: [{type: "text", text: found}]};
      if (config.toolError) result.isError = true;
      else result.structuredContent = {found: message.params.arguments.id};
    } else return new Response("Unknown method", {status: 400});
    if (protocol === "stateless")
      result = {...result, resultType: "complete", ttlMs: 60000, cacheScope: "private"};
    return new Response(JSON.stringify({jsonrpc: "2.0", id: message.id, result}), {headers: out});
  };
  return {fetch, seen};
}
void test("MCP skips a tool whose input schema is unsupported and keeps the rest", async () => {
  const mock = fixture("stateless", {badSchema: true});
  const {output} = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const mcp = yield* mcpTools({
          url: "https://fixture.test/mcp",
          namespace: "remote",
          protocol: "stateless",
          fetch: mock.fetch,
        });
        return {tools: Object.keys(mcp.tools), warnings: mcp.warnings};
      })(),
    ),
  );
  assert.deepEqual(output, {
    tools: ["remote_lookup", "remote_forbidden"],
    warnings: ["Ignored MCP tool with an unsupported input schema: remote_broken"],
  });
});

for (const echo of ["result", "error"] as const) {
  void test(`MCP redacts a credential the server echoes in its ${echo}`, async () => {
    const mock = fixture("stateless", {echo});
    const {output, journal} = await runHandler((ctx: Context) =>
      r.execute(
        ctx,
        (function* () {
          const mcp = yield* mcpTools({
            url: "https://fixture.test/mcp",
            namespace: "remote",
            protocol: "stateless",
            fetch: mock.fetch,
            retry: {maxAttempts: 1},
            deferred: false,
            *token() {
              return "secret-token";
            },
          });
          const a = agent({
            tools: mcp.tools,
            *model(req): r.Operation<ModelResponse> {
              if (!req.messages.some((m) => m.role === "tool"))
                return {
                  type: "tool_calls",
                  calls: [{id: "lookup-1", name: "remote_lookup", input: {id: "42"}}],
                };
              return {type: "final", text: "done"};
            },
          });
          return (yield* a.run("find it")).messages;
        })(),
      ),
    );
    const recorded = journal.map((frame) => Buffer.from(frame).toString("utf8")).join("");
    assert.ok(!recorded.includes("secret-token"), "the journal holds no credential");
    assert.ok(!JSON.stringify(output).includes("secret-token"));
    assert.match(JSON.stringify(output), /\[redacted\]/);
  });
}

void test("MCP fails once, without retries, when its own checks reject a catalog", async () => {
  const mock = fixture("stateless", {tooMany: true});
  const {output} = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        try {
          yield* mcpTools({
            url: "https://fixture.test/mcp",
            namespace: "remote",
            protocol: "stateless",
            fetch: mock.fetch,
          });
          return "loaded";
        } catch (error) {
          return error instanceof TerminalError ? error.message : "retryable";
        }
      })(),
    ),
  );
  assert.equal(output, "MCP catalog exceeds 128 tools");
  assert.equal(mock.seen.filter((x) => x.method === "tools/list").length, 1);
});

/** Runs one remote_lookup call and returns the result the model saw. */
async function lookupResult(mock: ReturnType<typeof fixture>) {
  const {output} = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const mcp = yield* mcpTools({
          url: "https://fixture.test/mcp",
          namespace: "remote",
          protocol: "stateless",
          fetch: mock.fetch,
          deferred: false,
        });
        let seen: unknown;
        const a = agent({
          tools: mcp.tools,
          *model(req): r.Operation<ModelResponse> {
            const result = req.messages.find((m) => m.role === "tool");
            if (!result)
              return {
                type: "tool_calls",
                calls: [{id: "lookup-1", name: "remote_lookup", input: {id: "42"}}],
              };
            seen = result.result;
            return {type: "final", text: "done"};
          },
        });
        yield* a.run("find it");
        return seen;
      })(),
    ),
  );
  return output as {status: string; code: string; message: string};
}

void test("an MCP tool error reaches the model as a tool error, without retries", async () => {
  const mock = fixture("stateless", {toolError: true});
  const result = await lookupResult(mock);
  assert.equal(result.status, "error");
  assert.equal(result.code, "tool_error");
  assert.match(result.message, /found 42/);
  assert.equal(mock.seen.filter((x) => x.method === "tools/call").length, 1);
});

void test("an oversized MCP result reaches the model as an output-limit error", async () => {
  const result = await lookupResult(fixture("stateless", {bigResult: true}));
  assert.equal(result.status, "error");
  assert.equal(result.code, "output_limit");
});

void test("MCP authorization fails terminally without a refresh, or when refreshing does not help", async () => {
  for (const refresh of [false, true]) {
    const mock = fixture("stateless", {unauthorized: true});
    let refreshes = 0;
    const {output} = await runHandler((ctx: Context) =>
      r.execute(
        ctx,
        (function* () {
          try {
            yield* mcpTools({
              url: "https://fixture.test/mcp",
              namespace: "remote",
              protocol: "stateless",
              fetch: mock.fetch,
              *token() {
                return "old";
              },
              ...(refresh
                ? {
                    *onAuthorizationRequired() {
                      refreshes++;
                    },
                  }
                : {}),
            });
            return "loaded";
          } catch (error) {
            return error instanceof TerminalError ? error.message : "retryable";
          }
        })(),
      ),
    );
    if (refresh) {
      assert.equal(output, "MCP authorization failed after three attempts");
      assert.equal(refreshes, 2);
    } else assert.equal(output, "MCP authorization required");
  }
});

void test("MCP tool calls use the configured retry policy", async () => {
  const mock = fixture("stateless", {unavailable: true});
  const {output} = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const mcp = yield* mcpTools({
          url: "https://fixture.test/mcp",
          namespace: "remote",
          protocol: "stateless",
          fetch: mock.fetch,
          retry: {maxAttempts: 1},
          deferred: false,
        });
        const a = agent({
          tools: mcp.tools,
          *model(req): r.Operation<ModelResponse> {
            const result = req.messages.find((m) => m.role === "tool");
            if (!result)
              return {
                type: "tool_calls",
                calls: [{id: "lookup-1", name: "remote_lookup", input: {id: "42"}}],
              };
            assert.equal(result.result.status, "error");
            return {type: "final", text: "done"};
          },
        });
        return (yield* a.run("find it")).status;
      })(),
    ),
  );
  assert.equal(output, "completed");
  assert.equal(mock.seen.filter((x) => x.method === "tools/call").length, 1);
});

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

void test("an expired stateful session is reported to the model instead of silently replaced", async () => {
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
            *model(request) {
              if (request.step === 2) return {type: "final", text: "session expired"};
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
  const failure = first.output.messages.find((m: Message) => m.role === "tool")?.result;
  assert.equal(failure?.status, "error");
  assert.match(failure?.message, /404|Session not found/);
  assert.equal(mock.seen.filter((x) => x.method === "initialize").length, 1);
});
