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
messages in object state, 8 messages per state key. Set `compaction` on the
agent to keep what the model reads short: when a run summarizes its context,
it stores the summary in the conversation, and the next run starts from the
summary and the messages after it (see
[Long runs](#long-runs-large-results-and-compaction)). Preload the
conversation's metadata and summary keys on the object, and let Restate read
the message chunks when a handler needs them:

```ts
const support = agent({model, instructions, tools, compaction: {maxTokens: 64000}});

export const aiSession = restate.object({
  name: "AiSession",
  handlers: {
    *doTurn(message: string) {
      const conversation = new LazyStateConversation();
      const result = yield* support.run(message, {conversation});
      if (result.status !== "completed") return result.output ?? result.reason;
      return result.output;
    },
    // The saved conversation, including a turn that is still running.
    *history() {
      return yield* new LazyStateConversation().page();
    },
  },
  options: {
    // Message chunks are read on demand.
    state: {preload: ["conversation/meta", "conversation/summary"]},
    handlers: {history: {shared: true}},
  },
});
```

**Preload only small keys.** By default, Restate sends a snapshot of all of
the object's state when each invocation starts, including invocations of
shared handlers such as `history`. Compaction changes what the model reads,
not what is stored: every chunk stays in state so `page()` can return the full
history. Without a preload list, every invocation of the object receives the
entire history, although a run loads only the chunks after the last summary.
With the list, Restate sends only the listed keys and fetches every other key,
including each chunk, when it is read. Add your own small keys to the list,
such as the `active` key in
[Steer and interrupt a running turn](#steer-and-interrupt-a-running-turn).

- `conversation/meta` holds the message count. The chunk keys
  (`conversation/0`, `conversation/1`, ...) follow from the count, and every
  load, append and `page()` reads the metadata key first, so always preload
  it. With a custom `stateKey`, the key is `<stateKey>/meta`; with a custom
  `metaKey`, list that key.
- `conversation/summary` holds the latest summary and how many messages it
  replaces. Every load reads it to find the first message to load, so
  preload it too. Saves do not rewrite it. With a custom `stateKey`, the key
  is `<stateKey>/summary`; a custom `metaKey` does not change it.
- Each key that is not preloaded costs a round trip to Restate when it is
  read. Loading the conversation reads one chunk key per 8 messages since
  the last summary.
- On AWS Lambda and other serverless platforms without bidirectional
  streaming, each lazy read adds a suspension: the invocation suspends and
  replays once Restate sends the requested state. If your conversations stay
  short there, preloading all state (the default) can cost less.
- A list of keys requires Restate 1.8 or later: an older server rejects the
  deployment at registration because it does not support
  `eagerStateKeysWhitelist`. On older servers, use
  `state: {preload: false}`; the metadata and summary keys are then read
  lazily as well.
- To set it for one handler only, put `state` in `options.handlers`. The
  deprecated `enableLazyState: true` equals `state: {preload: false}`.

### When a run saves

A run saves to its `conversation` while it runs, so `page()` in a shared
handler shows the turn that is running:

- **After each model call that returns tool calls.** The calls are saved before
  they run, with the previous batch's results. While the tools run, the saved
  history ends with calls that have no results yet.
- **When steering is accepted.** Steering that arrives during a batch is saved
  with the next save, after the batch's results, because results must follow
  their calls.
- **When the turn ends**, with the final answer once `afterRun` accepts it.

Tool results and background results are saved with the next save. A background
call's result is its pending acknowledgment until the run collects the real
result. To show results as they happen, use `onProgress` events; `page()`
returns the history as of the last save.

Each save appends to the last one. The saved messages stay the full record:
error notes and rejected answers never reach them. A run's summary is stored in
`conversation/summary`, not as a message, so `page()` still returns every message.

Restate journals every state read with its value. Within one invocation,
`LazyStateConversation` reads each state key at most once and keeps what it
read and wrote, so the load, the saves, and storing a summary don't journal
the same messages again. A shared handler that calls `page()` twice in one
invocation gets the values from its first read; call it once per invocation.

A run that fails with a terminal error saves what it recorded, closes
unfinished calls with `cancelled` results, and adds a note on the failure; see
`error-handling.md`. The input is saved with the run's first save, so a caller
that calls the handler again with the same input after a failure starts a new
turn after the failed one. To retry the same request, call the handler with an
idempotency key.

A killed invocation (`restate invocations kill`) runs no more code, so calls it
saved can stay without results. The next run closes each one with a
`cancelled` result saying that the call was interrupted and may have taken
effect, and its first save stores it. A cancelled run closes its calls itself,
with the reason, so prefer cancelling.

If storing a summary fails with an error, the run logs a warning and continues.
The next run then loads every message after the last stored summary and
summarizes again. A conversation that another writer changed, or that already
holds a summary covering as many messages, stores nothing, without a warning.

## Long runs: large results and compaction

A run's context grows with every step as its tool results pile up. Two
settings keep it in bounds, and neither changes the transcript:
`result.messages` and the conversation's `page()` keep every message whole.

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
  replay, and for earlier turns of a saved conversation back to its stored
  summary. A later run cannot read a ref from a message the summary replaced:
  the model gets an `unknown_ref` error.
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
  never separated from its results. The rest become one summary. The note
  that carries it also restates the run's input once the input is summarized,
  and lists background calls still running. A previewed result keeps its
  ref, so it can still be read for the rest of the run.
- With a `conversation`, the run stores the summary in it at its next save,
  in place of the messages the summary replaces. The next run loads the
  summary and the messages after it, so it does not summarize the same
  messages again. The restated input and the pending calls are not stored.
  The summary covers each request and how far it got, because later turns
  read it too. Like the conversation, it leaves out rejected answers and error
  notes.
- A later run knows only the tool-call IDs after the stored summary. If a
  provider reuses an earlier ID, the run accepts the call, and `page()` returns
  the ID twice. Providers that generate unique IDs are not affected.
- The tool-free finalization of a stopped run also sees the compacted view.
- Compaction summaries do not run `beforeStep`: the compaction model gets the
  history as recorded. Redact with `beforeRun`, `beforeSteering` and `afterTool`
  instead.
- Steering and interrupts wait until compaction finishes. If the compactor
  fails, the run logs it, stops summarizing and truncates instead: the older
  messages give way to a short note that restates the input and lists pending
  calls. A truncation is never stored, so the next run summarizes again. An
  `AgentTerminalError` from the compactor fails the run instead.

**Set `contextWindow` to avoid overflows.** Before each model call, a view
that would not fit the window with `maxOutputTokens`, or with 32,768 tokens for
the reply when `maxOutputTokens` is unset, is shrunk first: summarized when
`compaction` is set, truncated otherwise, to `compaction.retainTokens` or a
quarter of the window, whichever is smaller, and at most half of what
instructions, tools and the reply leave. A window of 32,768 tokens or less
needs `maxOutputTokens`.

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
