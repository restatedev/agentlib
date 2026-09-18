# SDK feature coverage

The implementation lives in `packages/core`; examples and tests are separate
workspace packages. `replit-final` is the golden behavioral reference. The Giselle
extraction supplied additional embedding and adapter patterns; its initial review
is preserved in [giselle-reference.md](giselle-reference.md).

All items below are implemented. This is local implementation/test coverage, not a
claim of production certification across external providers and MCP servers.

| Capability                                                         | Implementation                                 | Principal tests in `packages/tests/src`                                       |
| ------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Coroutine-native embedding and private context                     | `agent.ts`, `types.ts`, `tool.ts`              | `agent.test.ts`, `types.ts`                                                   |
| Provider selection, durable retries, Restate gateways              | `model.ts`, `openai.ts`, `provider.ts`         | `openai.test.ts`, `composition-provider.test.ts`, `runtime.integration.ts`    |
| Guardrails, approvals, nested dispatch                             | `agent.ts`, `tool.ts`                          | `lifecycle.test.ts`, `catalog-program.test.ts`                                |
| Parallel/background tools, failure cleanup, selective cancellation | `agent.ts`, `builtins.ts`                      | `lifecycle.test.ts`, `runtime.integration.ts`                                 |
| PTC with bounded QuickJS execution                                 | `program.ts`, `ptc/guest.ts`, `ptc/runtime.ts` | `ptc-guest.test.ts`, `ptc-lifecycle.test.ts`, `catalog-program.test.ts`       |
| Stateless/stateful MCP, durable auth hooks and catalog             | `mcp.ts`                                       | `mcp.test.ts`                                                                 |
| Permission-scoped, deferred tool search                            | `tool-search.ts`, `builtins.ts`                | `catalog-program.test.ts`                                                     |
| Annotated Restate handler discovery                                | `discovery.ts`                                 | `integrations.test.ts`, `runtime.integration.ts`                              |
| History-preserving handoffs and shared budgets                     | `tool.ts`, `agent.ts`                          | `composition-provider.test.ts`                                                |
| Durable chunked conversation storage and compaction                | `conversation.ts`                              | `conversation.test.ts`, `runtime.integration.ts`                              |
| Steering, interruption, cancellation and finalization              | `agent.ts`                                     | `lifecycle.test.ts`, `composition-provider.test.ts`, `runtime.integration.ts` |
| Progress, generator update hooks, event iteration                  | `types.ts`, `agent.ts`                         | `agent.test.ts`, `lifecycle.test.ts`                                          |
| Live and journaled model chunks                                    | `provider.ts`                                  | `composition-provider.test.ts`                                                |
| Structured output repair and guarded transcript                    | `agent.ts`, `provider.ts`                      | `composition-provider.test.ts`, `conversation.test.ts`                        |
| OTel/Braintrust-compatible hooks and Tavily search                 | `telemetry.ts`, `web-search.ts`                | `integrations.test.ts`                                                        |
| Full/partial replay and no repeated committed I/O                  | Entire runtime                                 | `replay.test.ts`, adapter replay tests, `runtime.integration.ts`              |

## Relationship to the reference

The QuickJS guest/runtime and search ranking derive from `replit-final`'s core
PTC and session modules. Background acknowledgments, separate completion
observations, steering, interruption cleanup, and two-phase compaction retain the
reference's behavior while moving ownership into operations embedded by the caller.

The SDK has a small JSON message protocol and adapters to providers. It does not
require the reference application's session controller, deployment router,
frontend, credential database, or streaming service. `AiSession` demonstrates how
an application supplies those storage/control boundaries.

Several lifecycle checks are stricter than the Giselle extraction: later failures
wake blocked siblings immediately; provider truncation is rejected; interruption
halts inference and future dispatch; required run context is enforced in types;
and output policies replace the candidate in stored history.

## Validation and deployment boundaries

`pnpm build` gates compilation, TypeScript, Oxc type-aware linting, and formatting.
`pnpm test` exercises the coroutine scheduler and targeted journal/protocol fixtures.
`pnpm test:integration` uses the official `RestateTestEnvironment` and a Docker
`RestateContainer().alwaysReplay().disableRetries()`. Real-server coverage includes
approvals, steering, interruption, child cancellation, background results, PTC,
gateways, discovery, persisted compaction, and the example's shared controls.

The [self-review](self-review.md) records corrected lifecycle, catalog, and adapter
defects. Additional [examples](../packages/examples/README.md) cover parallel research
workers, evaluator-optimizer loops, and first-success racing. Their real-server tests
verify parallel dispatch, replayed effects, typed decisions, bounded exhaustion,
source-read policies, and cancellation cleanup.

Live provider/MCP credentials, OAuth endpoints, public transcript projection,
SSE/WebSocket delivery, exporter configuration, and host authorization belong to
the embedding application. The implemented hooks support these integrations;
there is no built-in web application. Compaction runs at turn boundaries or via
explicit prepare/summarize/apply operations. Live token delivery is best effort;
committed model output and accepted final output have durable semantics.
