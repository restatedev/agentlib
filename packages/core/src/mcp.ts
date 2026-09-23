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
import {positiveInteger} from "./limits.js";

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
/** A later step reconnects to the session and discovery captured by the catalog. */
type Resume = {session: Session; prior: PriorDiscovery};
export type McpToolSet<C = unknown> = {
  tools: Record<string, Tool<C>>;
  close(): restate.Operation<void>;
};
// The original tools/list validated the tools capability. A reconstructed Client
// skips initialize when resuming a session; seed only that already-verified capability.
class ResumedToolClient extends Client {
  override assertCapabilityForMethod(method: string): void {
    if (method === "tools/call") return;
    super.assertCapabilityForMethod(method);
  }
}
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_AUTH_ATTEMPTS = 3;

/** Keeps valid names readable; others get a sanitized prefix and a stable hash. */
function localToolName(original: string): string {
  if (TOOL_NAME.test(original)) return original;
  const prefix = original.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51);
  const suffix = createHash("sha256").update(original).digest("hex").slice(0, 12);
  return `${prefix}_${suffix}`;
}

/** Snapshot the catalog once. No process-local MCP session is a source of truth. */
export function* mcpTools<C = unknown>(options: McpOptions): restate.Operation<McpToolSet<C>> {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(options.namespace))
    throw new TerminalError("Invalid MCP namespace");
  const timeout = positiveInteger(options.timeoutMs ?? 60000, "timeoutMs");
  const endpoint = new URL(options.url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new TerminalError("MCP requires an HTTP(S) URL without embedded credentials");
  /** Opens a short-lived client for one journaled step and always closes it. */
  async function withClient<T>(
    token: string | undefined,
    signal: AbortSignal,
    resume: Resume | undefined,
    use: (client: Client, transport: StreamableHTTPClientTransport) => Promise<T>,
  ): Promise<T> {
    const {session = {}, prior} = resume ?? {};
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
    try {
      return await use(client, transport);
    } finally {
      await client.close();
    }
  }
  function* authorized<T>(
    name: string,
    fn: (token: string | undefined, signal: AbortSignal) => Promise<T>,
  ): restate.Operation<T> {
    for (let attempt = 1; ; attempt++) {
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
      if (attempt === MAX_AUTH_ATTEMPTS)
        throw new TerminalError("MCP authorization failed after three attempts");
      if (!options.onAuthorizationRequired) throw new TerminalError("MCP authorization required");
      yield* options.onAuthorizationRequired();
    }
  }
  const catalog = yield* authorized(`mcp-${options.namespace}-catalog`, (token, signal) =>
    withClient(token, signal, undefined, async (client, transport) => {
      const listed = await client.listTools(undefined, {
        signal,
        timeout,
        cacheMode: "refresh",
      });
      if (listed.tools.length > 128) throw new TerminalError("MCP catalog exceeds 128 tools");
      const discovery = client.getDiscoverResult();
      if (options.protocol === "stateless" && !discovery)
        throw new TerminalError("MCP stateless discovery missing");
      let prior: PriorDiscovery = {kind: "legacy"};
      if (discovery) prior = {kind: "modern", discover: discovery};
      return {
        tools: listed.tools,
        session: {
          id: transport.sessionId,
          version: transport.protocolVersion,
        },
        prior,
      };
    }),
  );
  const tools = new Map<string, Tool<C>>();
  for (const definition of catalog.tools) {
    if (options.allow && !options.allow(definition.name)) continue;
    const name = localToolName(`${options.namespace}_${definition.name}`);
    if (!TOOL_NAME.test(name) || tools.has(name))
      throw new TerminalError(`Invalid or duplicate MCP tool name: ${name}`);
    if (JSON.stringify(definition.inputSchema).length > 64000)
      throw new TerminalError("MCP input schema too large");
    tools.set(
      name,
      tool({
        description: definition.description?.slice(0, 4000) ?? `Call ${definition.name}`,
        provider: options.namespace,
        deferred: options.deferred ?? true,
        input: z.fromJSONSchema(definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
        *execute(input, context) {
          const result = yield* authorized(`mcp-${name}`, (token, signal) =>
            withClient(token, signal, catalog, (client) =>
              client.callTool(
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
              ),
            ),
          );
          if (JSON.stringify(result).length > 128000)
            throw new ToolError("MCP result exceeds 128000 characters", "output_limit");
          if (result.isError) throw new ToolError(JSON.stringify(result));
          return JSON.parse(JSON.stringify(result));
        },
      }),
    );
  }
  return {
    tools: Object.fromEntries(tools),
    *close() {
      if (!catalog.session.id) return;
      yield* authorized(`mcp-${options.namespace}-close`, (token, signal) =>
        withClient(token, signal, catalog, async (_, transport) => {
          await transport.terminateSession();
          return null;
        }),
      );
    },
  };
}
