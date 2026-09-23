# Restate Agents

An embeddable AI agent SDK native to Restate's generator SDK (`gensdk`). Agent
runs, tools, policies, and approvals are ordinary generator operations inside an
application-owned Restate handler, so every model call and tool result is
journaled and survives crashes and replays.

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {z} from "zod";

const support = agent({
  model: openAIModel({model: "gpt-5.6-luna"}),
  instructions: "Use lookupTicket to answer questions about tickets.",
  tools: {
    lookupTicket: asyncTool({
      description: "Look up a ticket's status.",
      input: z.object({ticketId: z.string()}),
      async execute({ticketId}) {
        return {ticketId, status: "open"}; // Any async API call; the result is journaled.
      },
    }),
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

The SDK includes parallel and background tools, human approval, handoffs,
structured output, conversation history with compaction, steering and
interruption, QuickJS programmatic tool calls, MCP, Restate service tools and
discovery, deferred tool search, provider adapters, and model tracing. The
[`@restate-agents/promise`](packages/promise) package runs the same agents from
regular SDK handlers. The [domain glossary](CONTEXT.md) defines runs, sessions,
conversations, and lifecycle controls.

## Workspace

| Package                                         | Purpose                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@restate-agents/core`](packages/core)         | SDK and optional model, MCP, PTC, discovery, search, and telemetry adapters         |
| [`@restate-agents/promise`](packages/promise)   | Regular SDK agent runs and tools returning Restate promises                         |
| [`@restate-agents/examples`](packages/examples) | Numbered tutorials for gensdk and promise APIs, from a first run to agent workflows |
| [`@restate-agents/tests`](packages/tests)       | Unit/replay tests, public API type checks, and real Restate integration tests       |

The workspace uses pnpm 11.19.0 and TypeScript 7. Packages are private and not
yet published. The [embedded SDK guide](docs/embedded-sdk.md) is the detailed
reference.

## Development

Prerequisites: Node.js 22+, pnpm 11.19.0, and Docker for integration tests.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:integration
```

| Command                 | Action                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `pnpm build`            | Compile, type check, type-aware lint, and formatting check         |
| `pnpm typecheck`        | Compile dependencies and check all package types                   |
| `pnpm lint`             | Run Oxc type-aware lint and type diagnostics; build packages first |
| `pnpm lint:fix`         | Apply safe Oxc lint fixes                                          |
| `pnpm format`           | Check formatting                                                   |
| `pnpm format:fix`       | Apply Oxfmt formatting                                             |
| `pnpm test`             | Run unit and complete/partial replay tests                         |
| `pnpm test:integration` | Run the official Restate Testcontainers harness in Docker          |
| `pnpm check`            | Run the build and both test suites                                 |
| `pnpm dev`              | Build the SDK and watch the example endpoint on port 9080          |
| `pnpm start`            | Run the compiled example endpoint                                  |

Turbo orders compilation before linting, so dependent declarations are available
to Oxlint's type-aware rules; lint and formatting run as root tasks following the
[Turborepo Oxc guide](https://turborepo.dev/docs/guides/tools/oxc). The
`require-yield` rule is disabled because a synchronous Restate operation still
implements the generator contract.

[CI](.github/workflows/ci.yml) runs the same checks on every pull request and
push to `main`: formatting, TypeScript 7 type checking, type-aware Oxlint, unit
tests on Node 22 and 24, and the integration suite.

The integration suite starts a real Restate server with forced replay and removes
its container afterward. It covers durable signals, approvals, interruption,
child-call cancellation, PTC, gateways, discovery, service tools, and persisted
compaction. Provider and MCP fixtures need no paid credentials.

## Run the examples

Start a Restate server, then:

```sh
export OPENAI_API_KEY=...
# Optional: AGENT_MODEL selects the example's model.
pnpm dev
pnpm dlx @restatedev/restate deployments register http://localhost:9080
curl localhost:8080/Hello/ask --json '"Say hello in one sentence."'
```

`pnpm dev` serves both flavors; `pnpm dev:gensdk` and `pnpm dev:promise` serve
one. Read the [numbered tutorial](packages/examples/README.md) from `01_hello.ts`
onward. Both flavors start with one agent run, then add tools, conversation
history, structured output, a draft-and-review loop, human approval, and service
tools. Later gensdk lessons race agents, fan out research workers, and build a
full support session with handoffs, steering, and interruption.

After updating the SDK, restart `pnpm dev` (or run `pnpm build` and restart
`pnpm start`), then rediscover the endpoint to register changed services.
