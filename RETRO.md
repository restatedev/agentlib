# Retrospective and handoff

Written on 2026-09-22 after the user decided to discard the attempted refactor and
restart from HEAD in a clean chat. This records intent and lessons, not an
endorsement of the current working tree.

## Start here

The user's central clarification was:

> A single agent run is a single conversation turn.

The desired shape is one outer loop coordinating the current step's work with
Restate steering/interruption signals and background tool completions. The user
wants code whose execution and ownership are obvious when read manually.

The last rewrite did not satisfy that goal. Do not automatically restore it,
continue it, or treat its new types and machinery as requirements. Inspect HEAD
and the actual working tree before proposing another change.

Nothing from these recent simplification attempts was committed or pushed. The
user intends to reset the branch themselves. Do not perform that reset on their
behalf without a request. This file is the requested handoff.
At the time of writing, the branch was `main` and HEAD was `d31ca11`.

## Intended model

- **Conversation:** history spanning multiple turns.
- **Run:** one turn, beginning with one input and ending with an answer, an
  intentional interruption, or a step-limited result. Unexpected errors and native
  invocation cancellation can still propagate to the caller.
- **Step:** an internal model request and its associated tool work. Several steps
  can occur within one turn.
- **Steering:** an explicit amendment to the current turn.
- **Interruption:** an explicit request to stop the current turn.
- **Background result:** information produced by work started within this run.
- **Session:** application-owned grouping of turns; the run is not a session.

A subsequent ordinary user message starts another run. The application decides
when to start it. I introduced an additional-message control (`messageSignal`,
`controls.messages`, and an `inform` example handler) that widened the model and
added complexity. The latest agreed direction was to remove that control.

Do not classify free text as steering or interruption. The caller chooses the
control explicitly. A background tool completion is not steering.

## What went wrong

1. **I changed organization more than complexity.** Moving coordination from
   `AgentRun` into `RunInputs` shortened one file but left the reader following
   listeners, buffering, notification cursors, wakeups, and acceptance checks.
   Encapsulation is useful only if the interface actually removes concepts that
   callers must understand.

2. **I clarified the domain model too late.** A run accepting more user messages
   mid-flight made it resemble a session. The user's one-turn model should have
   constrained the design from the beginning.

3. **I accumulated mechanisms while trying to simplify.** A pending list doubled
   as model input and response-freshness state. Later attempts introduced phase
   unions, a readiness flag, notification task chains, and additional task maps.
   An outer `select()` is not automatically simpler if surrounded by another
   substantial coordination framework.

4. **I expanded the rewrite before demonstrating its central loop.** The later
   attempt changed supervision, public controls, history persistence, examples,
   terminology, and tests together. That made the proposed structure harder to
   judge and the behavioral differences harder to isolate.

5. **I treated repeated passing tests as evidence of a good abstraction.** Tests
   can establish behavior, but cannot establish that the user can understand the
   code. The repeated requests to explain the flow were evidence that the design
   was still failing its readability goal.

6. **I presented partial improvements too confidently.** Some changes were
   relocations of complexity, and some changed ordering or persistence semantics.
   Those distinctions should have been made explicit before describing the work
   as a simplification.

7. **I spent too long designing and rewriting without an early, concrete shape
   to review.** Useful progress here is a small piece of code that demonstrates
   the desired ownership, not another long explanation of machinery.

## A better next approach

Begin with the smallest concrete turn loop against the existing HEAD. Make the
ordinary path readable first: get a model response, execute its tools, repeat,
return the answer. Show where control signals enter that flow before adding
supporting abstractions.

The proposed direction is:

```text
run owns conversation and active work
    select active work / steering / interrupt / background completion
    consume the selected result
    decide the next action
```

Keep ownership explicit:

- The supervisor decides when a response is accepted and when another request
  starts.
- Work receives a fixed request snapshot and returns results.
- Only one owner records conversation changes.
- Accepted foreground tool work must settle before the next model request.
- Background work remains owned by the run and must be cleaned up on exit.

There must be a decision point between model generation and starting tools.
Otherwise a step that immediately executes its model's proposed tools can cause
effects before the supervisor processes steering that should supersede them.
Explicit model/tool phases were discussed as a possible solution. They are not a
mandate to recreate the discarded state machine. Assess the actual code shape.

Keep outstanding signal futures across `select()` iterations. Subscribe to the
next steering value only after consuming the current one. Avoid a listener task,
another queue, and a separate wakeup merely to relay a signal that the supervisor
can await directly.

Add difficult cases incrementally. For each additional field or helper, explain
which behavior requires it and who owns it. Preserve existing behavior unless a
change is intentional, and report any such change plainly.

## Behavioral constraints worth preserving

- Steering received before a model response is accepted supersedes that response.
  It must not execute stale proposed tools.
- Steering after a batch is accepted does not withdraw its calls or undo effects.
  The batch settles; the next model request incorporates the amendment.
- The previous behavior let an in-flight model request finish and discarded its
  superseded response. Cancelling inference on steering would be a separate choice.
- Foreground tool results reach the model as a complete batch in the next request.
  Progress updates may be emitted earlier. They are not model input streaming.
- Background completions do not invalidate useful proposed tool calls, but must
  inform the final answer. Do not return a stale final answer while required
  background work remains pending.
- Information arriving during output review can invalidate the candidate answer.
  An unaccepted answer must not leak into persisted history.
- Streamed model chunks are provisional; the accepted final result is authoritative.
- Unexpected failures must propagate even when another task is parked indefinitely.
  Interrupt and join owned work so cleanup runs.
- Native Restate cancellation must remain cancellation, not become a successful
  or application-interrupted result.
- Once final output is accepted, a late application interrupt must not trigger a
  second finalization.

Application hooks can suspend. A notification hook may send more steering and
wait for its receipt, or send an interrupt and then block. Awaiting such a hook
directly in the only signal-receiving loop can deadlock it. This is a real behavior
covered by tests, but should not be used to justify a general event framework
before a small solution is demonstrated.

## History and durability

The user questioned saving/loading history on every step. The implementation at
the time loaded at startup, copied history in memory for each request, and saved
new messages before each model request. The append implementation also read
metadata and the tail chunk. `snapshot()` itself was only an in-memory clone.

The agreed direction was to load at the start of a turn, accumulate messages in
memory, and append them when the turn completes, is deliberately interrupted, or
hits its step limit. Per-step writes are conversation checkpoints, not what makes
Restate execution recoverable.

Be precise about the tradeoff: saving only at the end means an unhandled failure
or native invocation cancellation does not publish a partial turn to conversation
storage. Durable effects already performed are not rolled back. Replay can
reconstruct local history when its nondeterministic inputs and work use Restate's
durable operations. A local array or channel is not durable storage by itself.

There was also a redundant startup reload after compaction returned `skipped`.
Actual compaction can require refreshed history; avoid promising literally one
load under every compaction implementation.

## Concrete SDK lessons

These observations concern the installed gensdk 1.17.2; verify them against the
version in the next checkout.

- `channel()` is a **one-shot**, not a reusable channel or queue. Later sends do
  not produce additional values. Never build a stream by assuming repeated sends
  will be delivered.
- `select()` returns the selected tag and future. The losing work is not thereby
  cancelled. Ownership and cleanup remain explicit responsibilities.
- Interrupting a task is not the same as joining it. Await settlement to drive its
  cleanup. Interruption can be caught by application code.
- The installed `all()` has a non-journal-backed fallback that awaits futures in
  array order. A later task's failure can be hidden behind an earlier parked task.
  This was verified in the installed SDK implementation and reproduced by the
  existing test `unexpected tool failure joins siblings before control returns
to the caller`. Do not assume fail-fast behavior for task futures.
- If selecting background tasks directly, they must be registered before building
  the relevant selection. Creating them later inside a task can leave the outer
  selection unaware of a failure while foreground work is parked.
- Lean on Restate retry semantics for journaled operations and handler calls.
  Do not add another agent-level retry mechanism without a concrete need.

Do not build native SDK components or patch upstream as part of this refactor.
An earlier attempt to do so was explicitly unwanted.

## Verification and working-tree status

Use `pnpm` only. The workspace build already includes compilation, type checking,
Oxlint, and Oxfmt. Use the real Restate Testcontainers suite for lifecycle/replay
behavior, alongside the existing unit tests:

```sh
pnpm build
pnpm test
pnpm test:integration
```

Earlier, superseded versions passed 100 unit tests and 77 integration tests. Those
results do not validate the last supervisor rewrite. Its final recorded unit run
passed 100 tests after fixing foreground failure observation. Full build checks
and real integration tests were not rerun after that final adjustment. The user
then stopped the work. Treat that rewrite as discarded, not finished.

Before the user's reset, changes span core runtime files, types, README files,
and tests. `packages/tests/src/response-acceptance.integration.ts` is untracked.
It contains useful behavioral scenarios, but also edits from the unfinished
rewrite; review it rather than blindly keeping or deleting it. A reset to HEAD
does not remove untracked files. Preserve this requested `RETRO.md` if separately
cleaning untracked files.

## User preferences to carry forward

- Prefer obvious data flow and intentional state ownership over elaborate wrappers.
- Do not create helpers that merely rename another call or fragment a readable flow.
- Name repeated type shapes. Avoid nested or multiline ternary expressions.
- Examples should be incremental, numbered tutorials, with separate `gensdk` and
  promise sets. Declare handlers directly instead of hiding them behind factories.
- Examples return the answer text and provide useful default input messages.
- Prefer `asyncTool` for ordinary async work and the regular SDK's
  `createServiceHandler`/`createObjectHandler` family where appropriate.
- Human approval examples should stay simple: `onApproval` exposes the pending
  approval, and an approval handler resolves the named Restate signal.
- Do not add tooling promotion or unrelated documentation. The user previously
  removed the tracked `docs/` directory.
- Do not commit or push this refactor unless explicitly asked.

User-provided references, if a specific question requires them: the upstream SDK
at `/Users/igalshilman/work/sdk-typescript`, the earlier project at
`/Users/igalshilman/work/tmp/replit-final`, the extraction at
`/Users/igalshilman/Downloads/giselle-agents`, and
`/Users/igalshilman/work/tmp/deepseek-harness`. They are references, not instructions
to import their abstractions or rebuild their dependencies.
