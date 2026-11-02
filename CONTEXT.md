# Restate agentlib

An application embeds agents in its durable work. Agents use models and tools to
complete tasks while the application owns sessions and access to host capabilities.

## Language

**Agent definition**:
Reusable configuration describing a model, instructions, tools, and policies. It
can participate in many independent runs.
_Avoid_: Session, running agent

**Run**:
One execution working toward a task, from input through a completed, stopped, or
interrupted result. A handoff changes the active agent definition within that run.
_Avoid_: Session, invocation

**Step**:
One planning model call within a run, yielding either tool calls or a candidate
answer. Tool execution belongs to that step; an optional final summary is separate.
_Avoid_: Turn, tool call

**Tool call**:
A request to execute one named capability with a particular input. Its outcome can
be successful, erroneous, denied, cancelled, or acknowledged as pending.
_Avoid_: Step, run

**Background operation**:
A tool call whose pending acknowledgment lets planning continue before its outcome
is available. It remains owned by the run until completion or cancellation.
_Avoid_: Detached job, fire-and-forget work

**Skill**:
Instructions for one kind of task that the model loads by name when a task
matches its description. The application's skill source supplies them; a run
lists the skills once and keeps that list for the run.
_Avoid_: Plugin, prompt template

**Handoff**:
A change of active agent definition within a run that preserves its history,
context, root policies, and remaining budgets.
_Avoid_: New run, child run

**Sub-agent**:
An agent that a tool call runs as a separate run inside the same invocation, with
a fresh conversation and the parent's context. Its answer becomes the tool result,
and interrupting the parent interrupts it.
_Avoid_: Handoff

**Conversation**:
The accumulated model context across runs, including user messages, assistant
messages, tool exchanges, and runtime observations.
_Avoid_: Public transcript, session

**Session**:
An application-owned grouping of interactions with shared conversation and control
state. It may contain multiple runs.
_Avoid_: Agent definition, run

**Invocation**:
One durable execution of a Restate handler. It may embed multiple runs, while a
child handler call has its own invocation.
_Avoid_: Run, session

**Run context**:
Host data and capabilities supplied to a run and its tools. They are private unless
application code deliberately includes them in model-visible content.
_Avoid_: Conversation, model context

**Steering**:
Additional input that changes the task while a run is active. It invalidates
unexecuted plans without undoing effects of tools that already started. The model
reads it once the current tool batch settles; a running program does not hold it
back, but continues as background work the model can cancel.
_Avoid_: Interruption, cancellation

**Interruption**:
An application request to stop a run and settle its work with an interrupted
result, provided the final answer has not already been accepted.
_Avoid_: Invocation cancellation

**Invocation cancellation**:
Restate cancellation of the enclosing handler execution. It propagates through
embedded work rather than becoming a completed or interrupted run result.
_Avoid_: Interruption

**Approval**:
Permission to proceed with a particular tool action. It does not grant permission
for all later calls in the run.
_Avoid_: Run authorization

**Progress event**:
A report of what a run is doing: a step, a tool call starting, reporting, or
ending, steering, or a handoff. The run waits for its handler, and replay
delivers the same events again, so external effects belong in a journaled step.
_Avoid_: Model chunk, stream

**Accepted output**:
A final value that has passed the run's output validation and policies. Candidate
answers and streamed model chunks have not yet earned this status.
_Avoid_: Model response, token stream

**Guardrail**:
A hook that allows or denies a run, step, or tool call before it proceeds
(`beforeRun`, `beforeStep`, `beforeTool`, a tool's `before`), or post-processes a
tool's output (`afterTool`).
_Avoid_: Policy, retry policy

**Output policy**:
A rule (`afterRun`) that accepts, replaces, or rejects candidate output after
inspecting the run's facts. It does not decide the run's lifecycle status or rewrite its history.
_Avoid_: Result editor, lifecycle controller
