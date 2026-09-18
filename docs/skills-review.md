# AI Hero skills review — 2026-09-18

Installed and read `codebase-design`, `code-review`,
`improve-codebase-architecture`, `domain-modeling`, and `tdd` from
[`mattpocock/skills`](https://github.com/mattpocock/skills/tree/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering)
at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`.

The prior lifecycle corrections and workflow examples were checkpointed in
`979cd65`. The review used `git diff a37b47e...979cd65`, with separate standards and
requirements reviewers and a separate architecture survey. Requirements came from
the embedding guide, feature coverage, and the requested coroutine-native design.
The local documentation supplied standards; Fowler's code smells were treated as
heuristics, not automatic violations. Reviewers did not delegate further.

## Standards

No hard documented-standard violations were found. One design finding was raised:

- **Possible speculative generality: output policies return more authority than
  they have.** `AgentOptions.afterRun` receives and returns a mutable `RunResult`,
  although it may only reject or rewrite output. The runtime rejects edits to
  status, steps, and reason, and discards history edits. Narrowing the policy's
  responsibility would express these rules at its interface and keep lifecycle
  ownership in the run. The user selected this candidate for implementation; the
  resulting change is documented below.

The stream module, catalog module, example factories, and `completedOutput` helper
hide meaningful behavior. Keep cancellation and joined cleanup visible in the
examples: those operations are part of what the examples teach.

## Spec

No actionable requirements findings were found. The reviewed changes implement
guarded output publication, steering invalidation, root policies after handoff,
parallel research workers, evaluator feedback and exhaustion, and first-success
racing. The pnpm workspace and build gates remain intact.

This is a review of the implemented contracts. Live provider compatibility and
the factual quality of generated research remain outside the fixture-based tests.

**Review totals:** Standards: one design judgement, zero hard violations. Spec:
zero findings. The standards finding is the output-policy interface; no worst
requirements issue was identified.

## Architecture candidates

The architecture skill produced a visual report outside the repository. Its
candidates, in recommendation order, are:

| Candidate                                             | Strength        | Concrete benefit                                                                                  |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| Give output policies responsibility for output        | Strong          | Policy authors no longer return lifecycle facts owned by the run                                  |
| Keep search and visibility inside the catalog         | Worth exploring | The agent no longer coordinates search selection, journaling, loading, and visibility bookkeeping |
| Make the support-session model dependency replaceable | Worth exploring | Live and scripted models can exercise the same active session controls with real Restate          |

The user selected the output-policy candidate after receiving the report. The
catalog and session candidates remain proposals.

The survey explicitly retained the `Model` seam, `streamRun`, `awaitChild`,
`completedOutput`, and run-local task ownership. A generic task manager would need
to move tightly related lifecycle state through callbacks and could make the
interface harder to understand.

## Applied documentation and test guidance

- Added [CONTEXT.md](../CONTEXT.md) as a glossary, with no implementation decisions.
  It distinguishes runs from sessions and invocations, and application interruption
  from invocation cancellation.
- Added a learning path and concrete result explanations to the
  [example guide](../packages/examples/README.md). Orchestration stays visible in
  each example; the guide explains when context becomes model-visible.
- Applied the TDD skill's test-quality criteria to the existing public-interface
  and real Restate tests. New behavior should be tested one failing case at a time
  through agent operations or exported example handlers, replacing only external
  model I/O. Documentation edits do not justify implementation-mirroring tests.

## Selected implementation: output policies

`afterRun` now receives an isolated, deeply read-only `OutputCandidate`. It returns
nothing to approve the candidate, `{output}` to replace output, or throws to reject
it. `OutputDecision` forbids lifecycle fields, including when a caller returns a
variable rather than an object literal. The runtime checks untyped returns too,
retains authoritative lifecycle facts, and validates replacement output before
publication.

The research example now validates its citations without returning a full result.
Existing policy tests use output decisions; public type checks reject mutation of
candidate history and nested structured output, and reject returning a full result.
The [migration notes](embedded-sdk.md#tool-execution-policies-and-approvals) describe the breaking
change for existing `afterRun` callbacks.

The first new regression used the official real Restate harness with forced
replay. It failed on the old implementation with `Cannot read properties of
undefined (reading 'status')` when the policy returned nothing. The same regression
passed after the change, including persisted conversation and emitted final output.

Behavioral verification passed: all 90 unit/replay tests and all 24 real Restate
integration tests, with no failures or skips. The integration count includes the
new approval-without-lifecycle-return regression.

`pnpm build` also passed compilation, public type checks, type-aware Oxc linting
with zero warnings/errors, and formatting. Type checks cover immutable nested
array updates, preserved tuple positions, and rejection of full-result returns.
