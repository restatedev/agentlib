# Restate Agents

An embeddable AI SDK native to Restate's generator SDK (`gensdk`). Agent runs, tools,
policies, and approvals are generator operations inside an
application-owned Restate handler.

The SDK includes parallel and background tools, QuickJS programmatic tool calls,
MCP, deferred tool search, conversation compaction, steering, interruption,
handoffs, structured output, provider adapters, and model tracing.
The [domain glossary](CONTEXT.md) defines runs, sessions, conversations, and lifecycle controls.

## Workspace

| Package                                         | Purpose                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@restate-agents/core`](packages/core)         | SDK and optional model, MCP, PTC, discovery, search, and telemetry adapters         |
| [`@restate-agents/promise`](packages/promise)   | Regular SDK agent runs and tools returning Restate promises                         |
| [`@restate-agents/examples`](packages/examples) | Numbered tutorials for gensdk and promise APIs, from a first run to agent workflows |
| [`@restate-agents/tests`](packages/tests)       | Unit/replay tests, public API type checks, and real Restate integration tests       |

The workspace uses **pnpm 11.19.0** and **TypeScript 7.0.2**, the latest stable
TypeScript release verified against the registry on 2026-09-18. Packages are private;
no published package is assumed.

## Development

Prerequisites: Node.js 22+, pnpm 11.19.0; Docker for integration tests.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:integration
```

`pnpm build` compiles the core and examples, checks all package types, runs
Oxlint with **type-aware rules and type checking**, and verifies formatting with
Oxfmt. Turbo orders compilation before linting so dependent declarations are
available. Root lint and formatting checks run on every build. The `require-yield` rule is disabled because a synchronous Restate
operation still implements the generator contract. Oxc runs as root tasks following the
[Turborepo Oxc guide](https://turborepo.dev/docs/guides/tools/oxc).

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

The integration suite starts a real Restate server with forced replay and cleans
up its container afterward. It covers durable signals, approvals, interruption,
child-call cancellation, PTC, gateways, discovery, and persisted compaction.
Provider and MCP fixtures need no paid credentials. The in-process journal harness
is retained for targeted protocol regression tests.

## Run the examples

Start a Restate server, then:

```sh
export OPENAI_API_KEY=...
# Optional: AGENT_MODEL selects the example's model.
pnpm dev
pnpm dlx @restatedev/restate deployments register http://localhost:9080
curl localhost:8080/Hello/ask --json '"Say hello in one sentence."'
```

Read the [numbered tutorial](packages/examples/README.md) from `01_hello.ts` onward.
Both flavors start with one agent run, then introduce tools, conversation history,
structured output, and a draft-and-review loop. Lesson 06 in
[gensdk](packages/examples/src/gensdk/06_human_approval.ts) and
[promise](packages/examples/src/promise/06_human_approval.ts) shows how to
inspect and answer a pending approval before a tool executes. Later
lessons cover support sessions, concurrent agents, and parallel research.

Use `onApproval(request, context)` on a gensdk agent or run to publish approval
requests. The request includes its invocation ID, signal name, and tool arguments.
The SDK awaits the hook before waiting for the decision. Agent hooks run first
(root, then the tool's agent after a handoff), followed by the run hook. Each gets
its own request snapshot. Use Restate state, journaled I/O, or durable service calls
to externalize it. The promise flavor accepts `onApproval(request, ctx, context)`.
Core's `onHumanApproval` optionally replaces how the decision is obtained.

- [gensdk lessons](packages/examples/src/gensdk/01_hello.ts): `yield* agent.run(...)`; run with `pnpm dev:gensdk`.
- [Promise lessons](packages/examples/src/promise/01_hello.ts): `await agent.run(ctx, ...)`; run with `pnpm dev:promise` and call `PromiseHello/ask`.

`pnpm dev` serves both sets. Each lesson declares its agents and handlers directly;
the `app.ts` files register them in tutorial order.

The Chat Completions adapter sends `reasoning_effort: "none"` by default for GPT-5.6
requests with tools, avoiding the model's tool/reasoning compatibility error.
After updating the SDK, restart `pnpm dev` (or run `pnpm build` and restart
`pnpm start`). Rediscover the endpoint to register the new example services.
