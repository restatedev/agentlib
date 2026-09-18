// Embeddable adapter informed by replit-final and the Giselle SDK extraction.
import {createHash} from "node:crypto";
import {
  Client,
  InsufficientScopeError,
  type PriorDiscovery,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {ToolError} from "./errors.js";
import {tool} from "./tool.js";
import type {Tool} from "./types.js";

export type McpOptions = {
  url: string;
  namespace: string;
  protocol: "stateless" | "stateful";
  /** Resolve credentials in generator code (e.g. state or a secret-manager RPC). */
  token?(): restate.Operation<string | undefined>;
  /** Persist refreshed credentials before returning; may wait on a human signal. */
  onAuthorizationRequired?(): restate.Operation<void>;
  timeoutMs?: number;
  /** Restrict the catalog before exposing tools to the agent. */
  allow?(remoteName: string): boolean;
  deferred?: boolean;
  fetch?: typeof fetch;
};
type Session = {id?: string; version?: string};
// The original tools/list validated the tools capability. A reconstructed Client
// skips initialize when resuming a session; seed only that already-verified capability.
class ResumedToolClient extends Client {
  override assertCapabilityForMethod(method: string): void {
    if (method === "tools/call") return;
    super.assertCapabilityForMethod(method);
  }
}
/** Snapshot the catalog once. No process-local MCP session is a source of truth. */
export function* mcpTools<C = unknown>(
  options: McpOptions,
): restate.Operation<{
  tools: Record<string, Tool<C>>;
  close(): restate.Operation<void>;
}> {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(options.namespace))
    throw new TerminalError("Invalid MCP namespace");
  const timeout = options.timeoutMs ?? 60000;
  const endpoint = new URL(options.url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new TerminalError("MCP requires an HTTP(S) URL without embedded credentials");
  async function connect(
    token: string | undefined,
    signal: AbortSignal,
    session: Session = {},
    prior?: PriorDiscovery,
  ) {
    const Constructor = session.id ? ResumedToolClient : Client;
    const client = new Constructor(
      {name: "restate-agent-sdk", version: "0.1.0"},
      {
        capabilities: {},
        cachePartition: token ? createHash("sha256").update(token).digest("hex") : "anonymous",
        inputRequired: {autoFulfill: false},
        versionNegotiation: {
          mode: options.protocol === "stateless" ? {pin: "2026-07-28"} : "legacy",
        },
        listMaxPages: 16,
      },
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      sessionId: session.id,
      protocolVersion: session.version,
      ...(token ? {authProvider: {token: async () => token}} : {}),
      fetch: (input, init) => (options.fetch ?? fetch)(input, {...init, redirect: "error"}),
      onInsufficientScope: "throw",
    });
    try {
      await client.connect(transport, {
        signal,
        timeout,
        ...(prior ? {prior} : {}),
      });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return {client, transport};
  }
  function* authorized<T>(
    name: string,
    fn: (token: string | undefined, signal: AbortSignal) => Promise<T>,
  ): restate.Operation<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = options.token ? yield* options.token() : undefined;
      const result = yield* restate.run(
        async ({signal}) => {
          try {
            return {type: "ok" as const, value: await fn(token, signal)};
          } catch (error) {
            if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError)
              return {type: "auth" as const};
            throw error;
          }
        },
        {name, retry: {maxAttempts: 1}},
      );
      if (result.type === "ok") return result.value;
      if (attempt === 2) throw new TerminalError("MCP authorization failed after three attempts");
      if (!options.onAuthorizationRequired) throw new TerminalError("MCP authorization required");
      yield* options.onAuthorizationRequired();
    }
    throw new TerminalError("MCP authorization failed after three attempts");
  }
  const catalog = yield* authorized(`mcp-${options.namespace}-catalog`, async (token, signal) => {
    const {client, transport} = await connect(token, signal);
    try {
      const listed = await client.listTools(undefined, {
        signal,
        timeout,
        cacheMode: "refresh",
      });
      if (listed.tools.length > 128) throw new TerminalError("MCP catalog exceeds 128 tools");
      const discovery = client.getDiscoverResult();
      if (options.protocol === "stateless" && !discovery)
        throw new TerminalError("MCP stateless discovery missing");
      return {
        tools: listed.tools,
        session: {
          id: transport.sessionId,
          version: transport.protocolVersion,
        },
        prior: discovery
          ? ({kind: "modern", discover: discovery} as PriorDiscovery)
          : ({kind: "legacy"} as PriorDiscovery),
      };
    } finally {
      await client.close();
    }
  });
  const tools: Record<string, Tool<C>> = {};
  for (const definition of catalog.tools) {
    if (options.allow && !options.allow(definition.name)) continue;
    const original = `${options.namespace}_${definition.name}`;
    const name = /^[a-zA-Z0-9_-]{1,64}$/.test(original)
      ? original
      : `${original.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51)}_${createHash("sha256").update(original).digest("hex").slice(0, 12)}`;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || Object.hasOwn(tools, name))
      throw new TerminalError(`Invalid or duplicate MCP tool name: ${name}`);
    if (JSON.stringify(definition.inputSchema).length > 64000)
      throw new TerminalError("MCP input schema too large");
    tools[name] = tool({
      description: definition.description?.slice(0, 4000) ?? `Call ${definition.name}`,
      provider: options.namespace,
      deferred: options.deferred ?? true,
      input: z.fromJSONSchema(definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      *execute(input, context) {
        const result = yield* authorized(`mcp-${name}`, async (token, signal) => {
          const {client} = await connect(token, signal, catalog.session, catalog.prior);
          try {
            return await client.callTool(
              {
                name: definition.name,
                arguments: input as Record<string, unknown>,
              },
              {
                signal,
                timeout,
                maxTotalTimeout: timeout,
                toolDefinition: definition,
                headers: {
                  "Idempotency-Key": `${context.invocationId}:${context.name}:${context.callId}`,
                },
              },
            );
          } finally {
            await client.close();
          }
        });
        if (JSON.stringify(result).length > 128000)
          throw new ToolError("MCP result exceeds 128000 characters", "output_limit");
        if (result.isError) throw new ToolError(JSON.stringify(result));
        return JSON.parse(JSON.stringify(result));
      },
    });
  }
  return {
    tools,
    *close() {
      if (!catalog.session.id) return;
      yield* authorized(`mcp-${options.namespace}-close`, async (token, signal) => {
        const {client, transport} = await connect(token, signal, catalog.session, catalog.prior);
        try {
          await transport.terminateSession();
          return null;
        } finally {
          await client.close();
        }
      });
    },
  };
}
