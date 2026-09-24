# Tools

Lessons:
[02_tools.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/02_tools.ts),
[10_service_tool.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/10_service_tool.ts),
[11_coding_agent.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/11_coding_agent.ts),
[14_web_search.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/14_web_search.ts),
[17_mcp_tools.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/17_mcp_tools.ts)

Tools are a map on the agent (`tools: {name: tool}`) or on a single run
(`run(input, {tools})`). The key is the name the model sees. Inputs are Zod
schemas; the SDK validates the model's arguments before `execute` runs.

## asyncTool: an ordinary async call

```ts
import {asyncTool, ToolError} from "@restate-agents/core";

lookupTicket: asyncTool({
  description: "Look up a ticket's status.",
  input: z.object({ticketId: z.string()}),
  retry: {maxAttempts: 5, initialInterval: {milliseconds: 250}, exponentiationFactor: 2},
  async execute({ticketId}, {signal, callId, context}) {
    const response = await fetch(`https://tickets.example/${ticketId}`, {signal});
    if (response.status === 404) throw new ToolError(`No ticket ${ticketId}`, "not_found");
    return (await response.json()) as {ticketId: string; status: string};
  },
}),
```

The result is journaled once `execute` succeeds. It must be JSON: cast
`response.json()`, which is `unknown`, to the shape you return.

- A thrown `Error` retries under `retry`; the default is three attempts.
- A `ToolError` goes straight back to the model as a business error.
- A `TerminalError` stops retrying. Exhausted retries end the same way.
- In every one of these cases the model receives
  `{status: "error", code, message}`, and the run continues.
- Use `retry: {maxAttempts: 1}` for actions that must not repeat, such as
  running a shell command.

## tool: compose Restate operations

`tool` has a generator `execute`, so it can use anything from the gen SDK:
RPC, `restate.run`, sleeps, signals, and state.

```ts
import {tool} from "@restate-agents/core";

reserve: tool({
  description: "Reserve stock for an order.",
  input: z.object({sku: z.string(), quantity: z.number().int().positive()}),
  *execute({sku, quantity}, {context}) {
    const ok = yield* restate.client(inventory, sku).reserve(quantity);
    if (!ok) throw new ToolError(`Not enough ${sku}`, "out_of_stock");
    return {sku, quantity, order: context.orderId};
  },
}),
```

Code in the generator body re-runs on replay. Put external I/O in
`restate.run` or `asyncTool`.

## Restate handlers as tools

```ts
import {handlerTool, serviceTool} from "@restate-agents/core";

// One handler, with the arguments you choose:
sendEmail: handlerTool({
  description: "Send an email.",
  input: z.object({to: z.string(), body: z.string()}),
  call: (input) => restate.client(emails).send(input),
}),

// A whole service from its interface: the model picks the handler.
// Descriptions and input schemas come from restate.iface.schemas.
refund: serviceTool(refundIface),
```

Each call is a durable child invocation. Interrupting the run cancels it,
and a failed handler is reported to the model as a tool error. Pass
`{iface, handler: "issueRefund"}` to scope `serviceTool` to one handler.
Objects and workflows also take a `key`. Configure retries with
`retryPolicy` on the called handler.

`restateTools({adminUrl, allow})` from `@restate-agents/core/discovery`
builds tools from every registered handler annotated with the metadata key
`restate.dev/agent`. Filter the result with `allow`.

## Per-request resources through context

A tool reads run `context` for things like sandboxes, clients, and tenant
data. Create the resource in a journaled step before the run and release it
in `finally` (lesson 11):

```ts
function* (task) {
  const sandbox = yield* connect();          // restate.run creates it once
  try {
    return replyText(yield* coder.run(task, {context: {sandbox}}));
  } finally {
    yield* release(sandbox);                 // restate.run terminates it once
  }
}
```

Inside `agent<Ctx>({tools: {...}})`, `context` is typed from the agent. A
tool defined on its own needs the type on its variable, or `context` is
`unknown`:

```ts
const readFile: Tool<Ctx> = asyncTool({
  description: "Read a text file.",
  input: z.object({path: z.string()}),
  execute: ({path}, {context}) => context.sandbox.filesystem.readText(path),
});
```

## Remote and built-in tools

```ts
import {mcpTools} from "@restate-agents/core/mcp";
import {webSearch} from "@restate-agents/core/web-search";

// Inside a handler: the catalog is fetched once and journaled.
const docs = yield* mcpTools({
  url: "https://docs.restate.dev/mcp",
  namespace: "docs", // tools become docs_<name>
  protocol: "stateless",
  deferred: false, // default true: hidden until searched
  allow: (name) => name !== "submit_feedback",
});
const result = yield* guide.run(question, {tools: docs.tools});

// Web search through Tavily; results are journaled.
const researcher = agent({model, tools: {searchWeb: webSearch({apiKey})}});
```

`mcpTools` also takes `token` (a generator returning a bearer token) and
`protocol: "stateful"` for servers that need sessions. Call `close()` when
done with a stateful session.

## Large catalogs and advanced tool calling

| Option                                                            | Effect                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `deferred: true` on a tool, plus `searchTools: searchToolsTool()` | The tool's schema is hidden until the model searches for it                                                  |
| `background: true`                                                | The model gets a pending result and keeps working; the real result arrives in a later step                   |
| `sleepTool()`, `cancelOperationTool()`                            | Let the model wait durably, or cancel a background operation                                                 |
| `programTool()` (`/program`)                                      | The model writes one JavaScript program that calls several tools (runs in QuickJS; no network or filesystem) |
| `describe` / `context.describe(info)`                             | Display info for UIs, delivered through progress events                                                      |
| `context.callTool(name, input)`                                   | Call another tool from a tool, under the same policy and budgets                                             |
