# SDK self-review — 2026-09-18

The baseline SDK and pnpm workspace were checkpointed in commit `a37b47e` before
the review changes and new examples. The review covered coroutine ownership,
failure/interruption races, policy boundaries, model adapters, conversation
publication, PTC budgets, remote catalogs, tests, and the public embedding API.
`replit-final` remains the behavioral reference. The official Restate AI examples
provided the three new workflow patterns.

## Corrected findings

| Finding                                                             | Consequence before the change                                                             | Correction and evidence                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Steering invalidated final answers but not tool plans               | An old plan could execute a write after the user changed the task during inference        | Invalidate the entire model plan before dispatch; unit and real-server steering tests                                           |
| Final candidates entered history before output-policy acceptance    | Interrupting an asynchronous output guard could persist an unapproved answer              | Stage the candidate separately and append only after validation; in-memory and real VO persistence regressions                  |
| Output hooks could rewrite lifecycle metadata                       | A stopped run could be reported as completed, with an invented step count or reason       | Reject status/steps/reason changes; runtime retains ownership of history                                                        |
| A policy-provided stopped summary was absent from history           | Returned output and the next turn's context disagreed                                     | Append the accepted summary as its own assistant message                                                                        |
| Root step policies disappeared after handoff                        | A specialist could invoke a model without the root's per-step guard                       | Apply root policy followed by specialist policy before each request                                                             |
| Late interruption could break completion publication/cleanup        | A run whose final answer was accepted could still throw `RunInterrupted`                  | Make acceptance the cutoff for application-level interruption; native invocation cancellation is preserved                      |
| Structured-output transforms ran twice                              | A value transformed during parsing could change again during final validation             | Require output JSON Schema representability and reject transforms at definition time; normalize through `afterRun`              |
| JavaScript prototype property names were unsafe catalog keys        | A discovered tool named `__proto__` could vanish or change the catalog object's prototype | Build MCP and Restate catalogs with maps and materialize records with `Object.fromEntries`; prototype-name regression           |
| Invalid guest budgets could disable resource checks                 | `NaN`/infinite values could bypass comparisons                                            | Validate finite positive safe integers before VM allocation; share validation with model/tool limits and MCP timeouts           |
| GPT-5.6 Chat Completions tool requests inherited reasoning defaults | The runnable support example received the reported HTTP 400                               | Default tool requests to `reasoning_effort: "none"`, preserve explicit settings, test the actual serialized HTTP body           |
| Permanent OpenAI API failures were retried                          | Invalid requests and bad credentials repeated without any chance of recovery              | Convert non-retryable HTTP 4xx errors to terminal errors; preserve transport, timeout, conflict, rate-limit, and server retries |

The five initial lifecycle regressions were run against the baseline and failed
before the fixes. The late-interruption regression was also observed failing
before its fix. Existing full/partial journal tests continue to protect replay,
failure cleanup, tool ordering, approvals, PTC, and conversation compaction.

## Readability and abstraction changes

- `tool-catalog.ts` owns catalog merging, validation, search, and schema visibility.
  The agent loop now uses that abstraction when entering a run or handing off.
- `agent-stream.ts` owns the bounded stream queue and producer cleanup. Stream
  consumers receive their own event values even if an application hook mutates its copy.
- `limits.ts` centralizes configuration validation. Provider tool-call normalization
  is shared by streaming and non-streaming requests.
- Tool entries carry their launching background mode explicitly. Their construction
  no longer casts a partially initialized object into a complete task entry.
- The new examples share only model configuration and completion checking. Each
  workflow keeps its orchestration visible in its own file and accepts a model for tests.

## Skills and sources

The skill-installer catalog was checked for a relevant TypeScript design/readability
skill. It had no direct match, so no unrelated skill was installed. OpenAI Docs was
used for the reported model compatibility issue. Official documentation establishes
that GPT-5.6 defaults to medium reasoning; the API error supplied in the report
establishes the specific Chat Completions tool restriction. See the
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) and
[GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

The [example guide](../packages/examples/README.md#provenance-and-validation) links
each upstream source at the inspected commit and explains its adaptation.

## Verification

Final verification passed:

- `pnpm build`: compilation, all package type checks, Oxc type-aware lint with zero
  warnings/errors, and Oxfmt checks.
- `pnpm test`: 90 unit and journal/replay tests, no failures or skips.
- `pnpm test:integration`: 23 real Restate tests, including nine tests of the new
  examples, no failures or skips. Containers are stopped by the test hooks.
- `git diff --check`: no whitespace errors.

## Remaining boundaries

This review does not establish live provider or arbitrary MCP-server compatibility.
Provider protocol tests use the real client against HTTP fixtures; integration tests
use a real Restate server and credential-free models. The reported remote `bob`
session was not replayed or modified as part of verification.

Output schemas now explicitly exclude transforms, and output policies may no longer
rewrite lifecycle metadata. These are deliberate contract tightenings. Deploy code
changes against fresh runs or a deployment strategy compatible with in-flight
journals. The three examples are application code; they do not add a second agent
runtime, global service registration, or a dependency on a UI framework.

Compaction remains a turn-boundary optimization, live token delivery remains best
effort, and external side effects still need provider-side idempotency. Source IDs
in the research example are checked against actual tool reads; that check does not
prove the factual accuracy of model-written prose.
