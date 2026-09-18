# Restate Agents

An embeddable AI SDK native to Restate's coroutine SDK. Agent runs, tools,
policies, approvals, and update hooks are generator operations inside an
application-owned Restate handler.

The SDK includes parallel and background tools, QuickJS programmatic tool calls,
MCP, deferred tool search, conversation compaction, steering, interruption,
handoffs, structured output, provider adapters, streaming, and OTel hooks.
See the [embedding guide](docs/embedded-sdk.md) and [feature coverage](docs/sdk-status.md).

## Workspace

| Package                                         | Purpose                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@restate-agents/core`](packages/core)         | SDK and optional model, MCP, PTC, discovery, search, and telemetry adapters              |
| [`@restate-agents/examples`](packages/examples) | Support session, parallel research, evaluator loop, racing agents, and runnable endpoint |
| [`@restate-agents/tests`](packages/tests)       | Unit/replay tests, public API type checks, and real Restate integration tests            |

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
curl localhost:8080/AiSession/example/doTurn/send \
  --json '{"message":"Find ticket A and ask the specialist to close it"}'
curl localhost:8080/AiSession/example/status --json 'null'
```

The example exposes history, approval, steering, and interruption handlers. Its
ticket operations are demonstrations; no external tickets are changed. Optional
MCP configuration uses `MCP_SERVER_URL`, `MCP_PROTOCOL`, and `MCP_TOKEN`. See
[`ai-session.ts`](packages/examples/src/ai-session.ts) and the
[control examples](docs/embedded-sdk.md#runnable-examples-and-validation).

The same endpoint registers three additional examples adapted from
[Restate's AI examples](https://github.com/restatedev/ai-examples):

| Example                   | What it demonstrates                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `ResearchReport/generate` | Structured planning, parallel worker RPCs, context-backed source tools, citation guards, synthesis |
| `CodeReview/generate`     | Typed generation and evaluation, feedback across iterations, bounded work, explicit exhaustion     |
| `RacingAgents/answer`     | Concurrent embedded runs, first successful answer, cancellation and cleanup of the loser           |

See the [example commands and source references](packages/examples/README.md).
The [self-review](docs/self-review.md) records corrected defects and design decisions.

The Chat Completions adapter sends `reasoning_effort: "none"` by default for GPT-5.6
requests with tools, avoiding the model's tool/reasoning compatibility error.
After updating the SDK, restart `pnpm dev` (or run `pnpm build` and restart
`pnpm start`). Rediscover the endpoint to register the new example services.
