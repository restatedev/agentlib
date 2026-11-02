# Models and testing

## Model adapters

Every adapter journals each model call as one step with its own retry
policy. Constructing an adapter needs no credentials, so importing
services stays side-effect free.

```ts
import {openAIModel} from "@restatedev/agentlib/openai";

export const model = openAIModel({
  model: "gpt-5.6-luna",
  retry: {maxAttempts: 3, initialInterval: {milliseconds: 500}, exponentiationFactor: 2},
});
```

`openAIModel` speaks Chat Completions and reads `OPENAI_API_KEY` and
`OPENAI_BASE_URL`, so it also reaches compatible servers (DeepSeek, xAI,
OpenRouter, Ollama, vLLM); pass `client` for an `OpenAI` client of your own
and `settings` for request settings. For `gpt-5.6` models, tool requests
default to `reasoning_effort: "none"` unless `settings` says otherwise.

Any [AI SDK](https://ai-sdk.dev) provider works through `aiModel`:

```ts
import {anthropic} from "@ai-sdk/anthropic";
import {aiModel} from "@restatedev/agentlib/provider";

export const model = aiModel({model: anthropic("claude-sonnet-5-5"), retry: {maxAttempts: 3}});
```

`aiModel` also accepts `providerOptions`, an OpenTelemetry `tracer`, and
`onChunk` for streaming text to a UI. Different agents can use different
models: set `model` on each agent.

Prompt caching is on by default. `aiModel` marks the instructions (which
follow the tools), the newest message, and the message before the newest
model reply (where the previous request ended) as cache points for Anthropic
and Bedrock, so each step reads the previous step's prefix from the cache; other
providers cache prefixes on their own and ignore these options. Pass
`caching: false` to send none, for example for a Bedrock model without
prompt caching. Both adapters report `usage` when the provider gives counts:
`inputTokens` includes cached reads and writes, `cachedInputTokens` counts the
reads, and `cacheWriteInputTokens` the writes (`aiModel` only).

Both adapters send a tool schema in strict mode when it has an exact strict
form, so the model's arguments always match it: every property is required
(use `.nullable()` rather than `.optional()`) and there are no free-form maps.
`openAIModel` does the same for `output` schemas. Other schemas are sent as
they are.

`modelGateway(call)` sends model requests to another Restate handler. Use it
to centralize keys, quotas, or routing in one service:

```ts
import {modelGateway} from "@restatedev/agentlib/provider";

const viaGateway = modelGateway((request) => restate.client(gateway).generate(request));
```

A model is just a generator from `ModelRequest` to `ModelResponse`, so
`journaledModel(async (request, {signal}) => ...)` wraps any other client.

## Testing without paid model calls

Give the agents a fixture model and run the services in a real Restate
container with forced replay:

```ts
import {journaledModel, type ModelResponse} from "@restatedev/agentlib";

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
  `container: () => new RestateContainer().alwaysReplay().disableRetries()` (see
  `restate-gen-sdk`'s `running-and-testing.md`), then call the services
  through `@restatedev/restate-sdk-clients`.
- Assert on observable effects: tools that must run once really run once,
  approvals block until resolved, and a race loser is cleaned up.

The repository's
[examples.integration.ts](https://github.com/restatedev/agentlib/blob/main/packages/tests/src/examples.integration.ts)
tests the lessons this way.
