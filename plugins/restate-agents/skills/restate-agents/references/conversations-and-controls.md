# Conversations, live controls, and progress

Lessons:
[03_conversation.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/03_conversation.ts),
[09_support_session.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/09_support_session.ts),
[16_progress_feed.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/16_progress_feed.ts)

## Remember earlier requests

A conversation belongs to a key, so keep it in a virtual object. Load the
messages, pass them in, and save `result.messages`. A run that throws returns
no result; `messagesOf(error)` returns its history up to the failure, with a
note on why it failed:

```ts
import {agent, type Message} from "@restatedev/agentlib";

export const chatSession = restate.object({
  name: "ChatSession",
  handlers: {
    *ask(message: string) {
      const messages = (yield* restate.state().get<Message[]>("messages")) ?? [];
      const result = yield* assistant.run(message, {messages});
      restate.state().set("messages", result.messages);
      if (result.status !== "completed") return result.output ?? result.reason;
      return result.output;
    },
  },
});
```

`curl .../ChatSession/bob/ask` and `.../ChatSession/alice/ask` have separate
histories. Because the object runs one exclusive call per key at a time,
turns never interleave.

## Long conversations: LazyStateConversation

For long histories, pass a `conversation` instead of `messages`. It stores
messages in chunks in object state and summarizes old ones:

```ts
const conversation = new LazyStateConversation({
  compaction: {model, policy: {maxMessages: 64, retainMessages: 12}},
});
const result = yield* support.run(message, {conversation});
```

Read it from a shared handler with `yield* new LazyStateConversation().page()`.

**Preload only small keys for long or large conversations.** By default,
Restate sends a snapshot of all of the object's state when each invocation
starts, including invocations of shared handlers such as `steer` and
`status`. Compaction changes what the model reads, not what is stored: every
chunk stays in state so `page()` can return the full history. Once a
conversation has many turns or large messages, such as long tool results,
every invocation of the object receives the entire history, although a run
loads only the chunks after the last summary. Short conversations do not
need this; keep the default for them. For agents with long or large
conversations, list the keys to preload: the conversation's metadata key and
your own small keys. Restate fetches every other key, including each chunk,
when it is read:

```ts
export const aiSession = restate.object({
  name: "AiSession",
  handlers: {doTurn, history, steer, interrupt},
  options: {
    state: {preload: ["conversation/meta", "active"]}, // chunks are read on demand
    handlers: {history: {shared: true}, steer: {shared: true}, interrupt: {shared: true}},
  },
});
```

- `conversation/meta` holds the message count and the latest summary. The
  chunk keys (`conversation/0`, `conversation/1`, ...) follow from the
  count, and every load, append and `page()` reads the metadata key first,
  so always preload it. With a custom `stateKey`, the key is
  `<stateKey>/meta`; with a custom `metaKey`, list that key.
- Each key that is not preloaded costs a round trip to Restate when it is
  read. Loading the conversation reads one chunk key per 32 messages since
  the last summary.
- On AWS Lambda and other serverless platforms without bidirectional
  streaming, each lazy read adds a suspension: the invocation suspends and
  replays once Restate sends the requested state.
- A list of keys requires Restate 1.8 or later: an older server rejects the
  deployment at registration because it does not support
  `eagerStateKeysWhitelist`. On older servers, use
  `state: {preload: false}`; the metadata key is then read lazily as well.
- To set it for one handler only, put `state` in `options.handlers`. The
  deprecated `enableLazyState: true` equals `state: {preload: false}`.

### When a run saves

A run saves to its `conversation` while it runs, so `page()` in a shared
handler shows the turn that is running:

- **After each model call.** A tool step's calls are saved before they run. A
  final answer is saved once `afterRun` accepts it.
- **When a tool batch ends**, with every result. A background call's result is
  its pending acknowledgment; the real result is saved when the run collects it.
- **When steering is accepted.** Steering that arrives during a batch is saved
  after the batch's results, because results must follow their calls.

Each save appends to the last one. The saved history stays the full record:
error notes, rejected answers, and in-run compaction never reach it.

Restate journals every state read with its value. Within one invocation,
`LazyStateConversation` reads each state key at most once and keeps what it
read and wrote, so the load, compaction, and saves of a run don't journal the
same messages again. A shared handler that calls `page()` twice in one
invocation gets the values from its first read; call it once per invocation.

A run that fails with a terminal error saves what it recorded, closes
unfinished calls with `cancelled` results, and adds a note on the failure; see
`error-handling.md`. The input is saved with the first model call, so a caller
that calls the handler again with the same input after a failure starts a new
turn after the failed one. To retry the same request, call the handler with an
idempotency key.

A killed invocation (`restate invocations kill`) runs no more code, so its
batch's calls can stay without results. The next run gives each such call a
`cancelled` result saying that it may have taken effect, and saves it with its
first save.

When a run starts and the conversation compaction fails, the run logs a
warning and continues with the history it loaded; the next run tries again.
An `AgentTerminalError` from the compaction model fails the run instead.

## Long runs: large results and compaction

Conversation compaction runs before a run starts. A single run can still
outgrow the model's window as its tool results pile up. Two settings keep it
in bounds, and neither changes the transcript: `result.messages` and the
saved conversation keep every message whole.

**Tool-result previews are on by default.** A result estimated above
`toolResults.maxTokens` reaches the model as its head and tail, with a ref.
The model reads the rest with the built-in `read_tool_result` tool, which
every request lists while previews are on, so the tool list never changes
mid-run and the cached prefix stays valid. An agent without other tools lists
it only when its loaded history holds a preview:

```ts
const researcher = agent({
  model,
  tools: {search, fetchPage},
  toolResults: {maxTokens: 5000, previewTokens: 2500}, // the defaults; false shows results in full
});
```

- A ref stays readable after compaction folds its preview away. Each read
  returns up to four times `maxTokens` worth of characters.
- Background results are previewed the same way; their ref is the operation ID.
- Reads come from the journaled history, so they work after a restart and on
  replay, and for earlier turns of a saved conversation.
- `read_tool_result` is a reserved name while previews are on.

**Compaction is opt-in**, because it costs a model call. Set `compaction` to
summarize the run's older messages before a model call once the view passes
`maxTokens`:

```ts
const researcher = agent({
  model,
  tools: {search, fetchPage},
  maxSteps: 40,
  compaction: {maxTokens: 100000, retainTokens: 25000}, // the defaults; `model` defaults to the agent's
});
```

- The size is the input tokens the model reported for its last request plus
  an estimate for messages added since. Before any report, or after a
  compaction, it is an estimate of the messages, instructions and tool
  schemas (about four characters per token for text, two for JSON). Both
  adapters report usage.
- The newest messages that fit `retainTokens`, and at most half of what
  instructions and tools leave of `maxTokens`, stay verbatim; a tool call is
  never separated from its results. The rest become one handoff note, which
  restates the run's input once it is summarized and lists background calls
  still running. A previewed result keeps its ref, so it can still be read.
- The tool-free finalization of a stopped run also sees the compacted view.
- Compaction summaries do not run `beforeStep`: the compaction model gets the
  history as recorded. Redact with `beforeRun`, `beforeSteering` and `afterTool`
  instead.
- Steering and interrupts wait until compaction finishes. If the compactor
  fails, the run stops summarizing and truncates instead: the older messages
  give way to a short note that restates the input and lists pending calls.
  An `AgentTerminalError` from the compactor fails the run instead.

**Set `contextWindow` to avoid overflows.** Before each model call, a view
that would not fit the window with `maxOutputTokens` is shrunk first:
summarized when `compaction` is set, truncated otherwise, to
`compaction.retainTokens` or a quarter of the window, whichever is smaller,
and at most half of what instructions, tools and `maxOutputTokens` leave.

```ts
const researcher = agent({model, tools: {search, fetchPage}, contextWindow: 200000});
```

**Overflow recovery is always on, for overflows the model reports as such.**
A `ContextOverflowError` makes the run keep at most half of the view and ask
again once; if that request overflows too, the run fails with a terminal
error that `isContextOverflow` recognizes, also after a replay. The adapters
raise it only for a structured signal, never for an error message: OpenAI's
`context_length_exceeded` code, or HTTP 413. Some providers, such as
Anthropic, report an overflow as a plain 400, so set `contextWindow` for them.
A custom model throws `ContextOverflowError` itself.

Progress reports each cut as a `compaction` event with `mode` (`summary` or
`truncate`) and `reason` (`threshold`, `window` or `overflow`).

## Steer and interrupt a running turn

Name two signals on the run. Shared handlers deliver them to the running
invocation while the exclusive turn holds the object's lock:

```ts
*doTurn({message}) {
  restate.state().set("active", {invocationId: restate.handlerRequest().id});
  try {
    const result = yield* support.run(message, {
      conversation,
      steeringSignal: "steering",   // a string added as a user message before the next step
      interruptSignal: "interrupt", // stops the run; output is a short summary
    });
    if (result.status !== "completed") return result.output ?? result.reason;
    return result.output;
  } finally {
    restate.state().clear("active");
  }
},
*steer(message: string) {        // shared
  const active = yield* restate.sharedState().get<{invocationId: string}>("active");
  if (!active) return false;
  restate.invocation(active.invocationId).signal("steering").resolve(message);
  return true;
},
```

Configure `interrupt` the same way with the `"interrupt"` signal, and mark
`steer` and `interrupt` as `shared: true` in `options.handlers`. An
interrupt cancels unfinished tools and child invocations and returns
`{status: "interrupted", reason, output}`.

To control the run from your own loop instead of signals, pass
`controls: {steering, interrupt}`: `steering` is a function that returns the
next steering future, called again after each message, and `interrupt` is a
future. A steering future resolves to
a message string, or to `{message, data}`: `data` comes back on the
`steering` progress event, so the app can tell which of its messages the run
accepted.

An agent's `beforeSteering` hook checks each steering message before it acts:
it can allow it, replace it with `{message}`, or reject it with a reason. A
rejected message is never recorded and does not interrupt the work in
progress; a `steering-rejected` event carries the reason and the message's
`data`. See [approvals and guardrails](approvals-and-guardrails.md).

## Progress events

`onProgress` receives each event as the run goes: `step`, `tool-start`,
`tool-info`, `tool-progress`, `tool-end`, `steering`, `steering-rejected`,
`error-note`, `handoff`, and `compaction` (`applied` or `failed`). An
`error-note` reports an error the model received as a note instead of the run
failing, such as a failed `beforeStep`, with its `origin`, `code` and
`message`; the note itself is never saved. A tool reports partial
progress with `context.progress(value)`. `tool-end` carries
the call's final display `info`, so a UI can label a finished call from one
event; `tool-start` carries it too when the tool's `describe` is a fixed
label rather than a function of the input.

```ts
const feed = restate.sendClient(progressFeed, job);
const result = yield* auditor.run(request, {
  *onProgress(event) {
    feed.publish(event); // one-way send: the run does not wait for subscribers
  },
});
```

Lesson 16 pairs this with a pub/sub object (see `restate-gen-sdk`'s
`patterns.md`), so clients can `subscribe` and receive each next event.
Sub-agents started with `agentTool` and forks started with `forkAgentTool` report
their events as progress of the parent's tool call. Steering reaches the parent
run only: a sub-agent or fork in the foreground finishes its task before the
parent's model reads the steering message.

Progress events do not carry the model's text. To show text as the model
generates it, use `aiModel`'s `onChunk`; see "Stream model text with
`onChunk`" in `models-and-testing.md`.

## Tools for one run

`run(input, {tools})` adds tools to that run only, next to the agent's own.
They belong to the run, so they survive a handoff. Use them for tools that
depend on the request: lesson 17 passes the tools of an MCP server, and
[lesson 18](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/18_ag_ui.ts)
turns the tools an AG-UI client sends into tools that wait on a durable
signal until the client returns their result. The name `read_tool_result` is
reserved while `toolResults` is on, and `search_tools` and `run_program` while
the run adds them (see `toolSearch` and `codeMode` in `tools.md`).
