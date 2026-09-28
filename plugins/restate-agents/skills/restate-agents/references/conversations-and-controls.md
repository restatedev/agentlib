# Conversations, live controls, and progress

Lessons:
[03_conversation.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/03_conversation.ts),
[09_support_session.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/09_support_session.ts),
[16_progress_feed.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/16_progress_feed.ts)

## Remember earlier requests

A conversation belongs to a key, so keep it in a virtual object. Load the
messages, pass them in, and save `result.messages`:

```ts
import {agent, type Message} from "@restate-agents/core";

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

## Long runs: compaction

Conversation compaction runs before a run starts. A single run can still
outgrow the model's window as its tool results pile up. Set `compaction` on
the agent to summarize the run's older messages before a model call once the
messages it would send pass `maxChars`:

```ts
const researcher = agent({
  model,
  tools: {search, fetchPage},
  maxSteps: 40,
  compaction: {maxChars: 400000, retainChars: 100000}, // the defaults; `model` defaults to the agent's
});
```

- The newest messages that fit `retainChars` stay verbatim; a tool call is
  never separated from its results. The rest become one handoff note, which
  restates the run's input once it is summarized and lists background calls
  still running.
- Only the model's view changes: `result.messages` and the saved conversation
  keep every message.
- The tool-free finalization of a stopped run also sees the compacted view.
- Steering and interrupts wait until compaction finishes. A failed compaction
  keeps the full view and is not retried in that run.
- `maxChars` counts messages only, not instructions or tool schemas; leave
  room for them.

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
`controls: {steering, interrupt}` with futures. A steering future resolves to
a message string, or to `{message, data}`: `data` comes back on the
`steering` progress event, so the app can tell which of its messages the run
accepted.

## Progress events

`onProgress` receives each event as the run goes: `step`, `tool-start`,
`tool-info`, `tool-progress`, `tool-end`, `steering`, `handoff`, and
`compaction` (`applied` or `failed`). A tool
reports partial progress with `context.progress(value)`. `tool-end` carries
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
Sub-agents started with `agentTool` report their events as progress of the
parent's tool call.
