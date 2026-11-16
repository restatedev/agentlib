// Shared fixtures for the fork tests: an agent whose `delegate` tool forks the
// agent itself, and helpers to tell the parent's requests from a fork's.
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  forkTool,
  type Agent,
  type AgentOptions,
  type JsonValue,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type ToolResult,
} from "@restatedev/agentlib";
import {testContext} from "./helpers.js";

export const PREAMBLE = "[Forked sub-agent]";

export const execute = <T>(operation: r.Operation<T>) => r.execute(testContext("fork"), operation);

export const call = (id: string, name: string, input: {[key: string]: JsonValue} = {}) =>
  ({type: "tool_calls", calls: [{id, name, input}]}) satisfies ModelResponse;
export const calls = (...list: {id: string; name: string; input?: {[key: string]: JsonValue}}[]) =>
  ({
    type: "tool_calls",
    calls: list.map(({id, name, input}) => ({id, name, input: input ?? {}})),
  }) satisfies ModelResponse;
export const final = (text: string) => ({type: "final", text}) satisfies ModelResponse;
export const delegate = (id: string, task: string) => call(id, "delegate", {task});

/** Whether a request belongs to a fork: its input carries the fork preamble. A
 * compaction note quotes the input, so `includes` also finds a compacted fork. */
export const isFork = (request: ModelRequest) =>
  request.messages.some((message) => message.role === "user" && message.content.includes(PREAMBLE));

/** The task a fork was given, from its input message. */
export function forkTask(request: ModelRequest): string | undefined {
  const input = request.messages.find(
    (message) => message.role === "user" && message.content.startsWith(PREAMBLE),
  );
  return input?.role === "user" ? input.content.split("Task:\n")[1] : undefined;
}

/** The messages a fork inherited: its first request without its input message. */
export function inherited(request: ModelRequest): Message[] {
  const at = request.messages.findIndex(
    (message) => message.role === "user" && message.content.startsWith(PREAMBLE),
  );
  return request.messages.slice(0, at);
}

export function resultOf(messages: readonly Message[], callId: string): ToolResult | undefined {
  const message = messages.find((m) => m.role === "tool" && m.callId === callId);
  return message?.role === "tool" ? message.result : undefined;
}

export const toolNames = (request: ModelRequest) => request.tools.map((t) => t.name);

type ForkingOptions<O> = Omit<AgentOptions<undefined, O>, "model"> & {
  /** Answers both the parent's and the forks' requests; use `isFork` to tell them apart. */
  script?: (request: ModelRequest) => ModelResponse | r.Operation<ModelResponse>;
  model?: AgentOptions<undefined, O>["model"];
  /** Extra options for the `delegate` tool. */
  forkOptions?: Parameters<typeof forkTool>[0];
};

/** An agent with a `delegate` tool that forks the running agent. */
export function forkingAgent<O = string>(options: ForkingOptions<O>): Agent<undefined, O> {
  const {script, model, forkOptions, tools, ...rest} = options;
  return agent<undefined, O>({
    ...rest,
    tools: {
      ...tools,
      delegate: forkTool({description: "Fork yourself to do a subtask", ...forkOptions}),
    },
    model:
      model ??
      function* (request) {
        const answer = script!(request);
        return typeof (answer as {next?: unknown}).next === "function"
          ? yield* answer as r.Operation<ModelResponse>
          : (answer as ModelResponse);
      },
  });
}

/** A page large enough that the default preview settings shorten it. */
export const largePage = Array.from({length: 4000}, (_, i) => `line ${i}`).join("\n");
