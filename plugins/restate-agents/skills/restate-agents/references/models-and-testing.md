# Models and testing

## Model adapters

Every adapter journals each model call as one step with its own retry
policy. Constructing an adapter needs no credentials, so importing
services stays side-effect free.

```ts
import {openAIModel} from "@restate-agents/core/openai";

export const model = openAIModel({
  model: "gpt-5.6-luna",
  retry: {maxAttempts: 3, initialInterval: {milliseconds: 500}, exponentiationFactor: 2},
});
```

Any [AI SDK](https://ai-sdk.dev) provider works through `aiModel`:

```ts
import {anthropic} from "@ai-sdk/anthropic";
import {aiModel} from "@restate-agents/core/provider";

export const model = aiModel({model: anthropic("claude-sonnet-5"), retry: {maxAttempts: 3}});
```

`aiModel` also accepts `providerOptions`, an OpenTelemetry `tracer`, and
`onChunk` for streaming text to a UI. Different agents can use different
models: set `model` on each agent.

`modelGateway(call)` sends model requests to another Restate handler. Use it
to centralize keys, quotas, or routing in one service:

```ts
import {modelGateway} from "@restate-agents/core/provider";

const viaGateway = modelGateway((request) => restate.client(gateway).generate(request));
```

A model is just a generator from `ModelRequest` to `ModelResponse`, so
`journaledModel(async (request, {signal}) => ...)` wraps any other client.

## Testing without paid model calls

Give the agents a fixture model and run the services in a real Restate
container with forced replay:

```ts
import {journaledModel, type ModelResponse} from "@restate-agents/core";

const fixtureModel = journaledModel(async (request): Promise<ModelResponse> => {
  if (request.tools.length > 0 && request.step === 1)
    return {
      type: "tool_calls",
      calls: [{id: "t1", name: "lookupTicket", input: {ticketId: "T-42"}}],
    };
  if (request.outputSchema)
    return {type: "final", text: "", output: {category: "billing", summary: "…"}};
  return {type: "final", text: "Ticket T-42 is open."};
});
```

- Build agents from a model you can swap: pass it in, read it from a shared
  module, or mock that module in tests.
- Start `RestateTestEnvironment` with
  `container: () => new RestateContainer().alwaysReplay()` (see
  `restate-gen-sdk`'s `running-and-testing.md`), then call the services
  through `@restatedev/restate-sdk-clients`.
- Assert on observable effects: tools that must run once really run once,
  approvals block until resolved, and a race loser is cleaned up.

The repository's
[examples.integration.ts](https://github.com/restatedev/agentsdk/blob/main/packages/tests/src/examples.integration.ts)
tests every lesson this way.
