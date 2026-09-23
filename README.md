# Restate Agents

A TypeScript SDK for building AI agents that don't lose their work. It has the
harness features modern agents need: programmatic tool calling, live steering,
tool search, MCP, sub-agents, human approval, and background tools. It runs on
[Restate](https://restate.dev), so every model call, tool result, and decision
is durable. An agent survives crashes, deploys, and hours-long waits, and it
resumes exactly where it stopped.

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool, searchToolsTool} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {programTool} from "@restate-agents/core/program";
import {z} from "zod";

const support = agent({
  model: openAIModel({model: "gpt-5.6-luna"}),
  instructions: "Resolve support tickets. Search for tools you don't know yet.",
  tools: {
    lookupTicket: asyncTool({
      description: "Look up a ticket's status.",
      input: z.object({ticketId: z.string()}),
      async execute({ticketId}) {
        return {ticketId, status: "open"}; // Any async API call; the result is journaled.
      },
    }),
    program: programTool(), // The model writes code that orchestrates many tool calls.
    searchTools: searchToolsTool(), // Deferred tools stay hidden until the model finds them.
  },
});

export const tickets = restate.service({
  name: "Tickets",
  handlers: {
    *ask(question: string) {
      const result = yield* support.run(question);
      return result.status === "completed" ? result.output : result.reason;
    },
  },
});
```

## Harness features

**Programmatic tool calling (PTC).** `programTool()` lets the model answer with a
short JavaScript program instead of one tool call at a time. The program runs in
a QuickJS sandbox with no network, filesystem, clock, or randomness, and calls the
agent's tools with `Promise.all`, `race`, and friends. Every tool call inside it
goes through the same policies and approvals as a direct call, and every call is
journaled.

**Steering and interruption.** Send a message to a running agent and it changes
course: a model call in flight is discarded and the agent re-plans with the new
instruction, while running tools keep going. Interrupting stops the run cleanly.
Unfinished tools are cancelled, and the agent can summarize what it got done.
Both are durable signals, so they work even while the agent waits on a tool or a
human.

```ts
function* turn(message: string) {
  return yield* support.run(message, {
    steeringSignal: "steering",
    interruptSignal: "interrupt",
  });
}

// From any other handler, steer the running turn by its invocation ID:
function steer(invocationId: string) {
  restate.invocation(invocationId).signal("steering").resolve("Only look at ticket T-42.");
}
```

**Tool search.** Mark tools `deferred: true` and add `searchToolsTool()`. The
model starts with a small catalog, searches by name, provider, or parameters, and
loads full schemas only when it needs them. MCP tools are deferred by default,
so large remote catalogs stay out of the prompt.

**MCP.** `mcpTools({url, namespace, protocol})` snapshots a remote MCP server's
catalog into ordinary agent tools, over stateless or stateful Streamable HTTP.
Calls are journaled and carry idempotency keys, and authorization can pause for a
human to refresh credentials.

**Sub-agents.** `agentTool(subAgent, {description})` turns an agent into a tool.
The model delegates a self-contained task, and the sub-agent works on it with its
own fresh conversation, tools, and limits. Its answer, text or structured output,
comes back as the tool result. Sub-agents run in the same durable invocation, so
every step is journaled and interrupting the parent cancels them. Add
`background: true` to keep the parent working in the meantime.

```ts
const researcher = agent({
  model,
  instructions: "Research the question thoroughly and cite your sources.",
});
const lead = agent({
  model,
  instructions: "Plan the work and delegate research questions.",
  tools: {research: agentTool(researcher, {description: "Research one question."})},
});
```

`handoff(specialist)` transfers the conversation itself to another agent, and the
root agent's guardrails and budgets still apply. For full isolation, put an agent
behind its own Restate service and call it with `serviceTool` or `handlerTool`,
as a separate invocation.

**Human approval.** `needsApproval: true` pauses a tool until a person decides.
The run waits durably for minutes or days, without holding a process.

**Background tools.** Tools marked `background: true` return a pending result
right away. The model keeps working and sees the result when it arrives. It can
also cancel pending work with `cancelOperationTool()`.

**More.**

- Structured output validated with Zod.
- `beforeRun`, `beforeStep`, `beforeTool`, `afterTool`, and `afterRun` guardrails.
- Conversations stored in Restate state, with automatic compaction.
- Tools generated from any Restate service contract, or discovered from
  annotated handlers.
- Web search.
- OpenAI and [AI SDK](https://ai-sdk.dev) model adapters, plus a gateway for
  routing model calls through a Restate service.
- OpenTelemetry model tracing.

## Durable by default

Restate records every step of a run in its journal: model responses, tool
results, approvals, and steering messages. On a crash or redeploy, the agent
replays that journal instead of redoing the work. It doesn't call the model
again or repeat side effects, and it carries on from the next step.

- **Retries where they belong.** Model calls and tools retry transient failures
  with their own policies. A tool that fails for good becomes an error the model
  can react to, instead of crashing the run.
- **Cancellation that propagates.** Interrupting or cancelling a run cancels its
  model call, its tools, and any child invocations it started.
- **Waiting is free.** Approvals, sleeps, and slow tools suspend the run durably.
- **Composable with workflows.** An agent run is just a step in a Restate
  handler, so you can race agents, fan out workers, or chain a draft-and-review
  loop alongside ordinary durable code.

Agents run inside Restate's generator SDK (`@restate-agents/core`) or the regular
promise-based SDK (`@restate-agents/promise`). Both share the same models,
tools, and runtime.

## Examples

The [tutorial](packages/examples/README.md) builds up from a single agent call
to a full support session. Along the way it adds tools, conversation history,
structured output, a draft-and-review loop, human approval, service tools,
racing agents, parallel research workers, and a session that uses handoffs,
steering, interruption, PTC, tool search, and MCP together.

Start a Restate server, then:

```sh
export OPENAI_API_KEY=...
pnpm install --frozen-lockfile
pnpm dev
pnpm dlx @restatedev/restate deployments register http://localhost:9080
curl localhost:8080/Hello/ask --json '"Say hello in one sentence."'
```

`pnpm dev:gensdk` and `pnpm dev:promise` serve one flavor each. After updating
the SDK, restart the endpoint and rediscover it so Restate sees changed services.

## Workspace

| Package                                         | Purpose                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| [`@restate-agents/core`](packages/core)         | The agent SDK, plus optional model, MCP, PTC, and discovery adapters |
| [`@restate-agents/promise`](packages/promise)   | Agents and tools for regular promise-based Restate handlers          |
| [`@restate-agents/examples`](packages/examples) | Numbered tutorials, from a first run to multi-agent workflows        |
| [`@restate-agents/tests`](packages/tests)       | Unit, replay, and type tests, plus integration tests against Restate |

The [domain glossary](CONTEXT.md) defines runs, steps, sessions, conversations,
and lifecycle controls.

## Development

Requires Node.js 22+ and pnpm 11. Integration tests also need Docker.

```sh
pnpm build             # compile, TypeScript 7 type check, type-aware Oxlint, Oxfmt check
pnpm test              # unit and journal-replay tests
pnpm test:integration  # a real Restate server with forced replay, via Testcontainers
```

`pnpm check` runs all three. `pnpm lint:fix` and `pnpm format:fix` apply fixes.
[CI](.github/workflows/ci.yml) runs the same checks on every pull request and
push to `main`. Provider and MCP fixtures need no paid credentials.
