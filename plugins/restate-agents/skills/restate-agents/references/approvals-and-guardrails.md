# Approvals and guardrails

Lessons:
[06_human_approval.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/06_human_approval.ts),
[13_tool_guardrail.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/13_tool_guardrail.ts),
[08_research_report.ts](https://github.com/restatedev/agentlib/blob/main/packages/examples/src/lessons/08_research_report.ts) (`afterRun`)

## Human approval before a tool runs

Mark the tool `needsApproval: true`, or pass a generator
`(input, context) => boolean` to decide per call. Before running the tool,
the SDK calls `onApproval(request)` to publish the request, then waits on a
durable signal. The wait holds no process and has no default timeout.

```ts
const support = agent({
  model,
  tools: {
    closeTicket: asyncTool({
      description: "Close a ticket after human approval.",
      input: z.object({ticketId: z.string()}),
      needsApproval: true,
      async execute({ticketId}) {
        return await closeTicket(ticketId);
      },
    }),
  },
});

export const ticketApproval = restate.object({
  name: "TicketApproval",
  handlers: {
    *ask(message: string) {
      try {
        const result = yield* support.run(message, {
          *onApproval(request) {
            restate.state().set("approval", request); // or notify Slack/email via restate.run
          },
        });
        if (result.status !== "completed") return result.output ?? result.reason;
        return result.output;
      } finally {
        restate.state().clear("approval"); // never leave a request nobody waits for
      }
    },
    *status() {
      return yield* restate.sharedState().get<ApprovalRequest>("approval");
    },
    *approve({
      invocationId,
      signalName,
      approved,
    }: {
      invocationId: string;
      signalName: string;
      approved: boolean;
    }) {
      restate.invocation(invocationId).signal(signalName).resolve(approved);
      return true;
    },
  },
  options: {handlers: {status: {shared: true}, approve: {shared: true}}},
});
```

An `ApprovalRequest` carries `invocationId`, `signalName`, the proposed
`call` (tool name and arguments), and an optional `question`. If the request
is denied, the tool is skipped and the model gets a denied result.

Variants:

- `onApproval` can also go on the agent definition.
- `onHumanApproval(request, context)` replaces the decision mechanism
  entirely, for example to call an approval service with `restate.client`.
- `humanApprovalTool()` lets the model ask a free-form question and wait for
  a yes or no.
- For a time limit, set `onHumanApproval` and `restate.select` the signal
  against `restate.sleep`.

## Policy the model cannot bypass

Put trusted facts in run `context` and check them in the tool's `before`.
Return a string to deny with that reason, `false` to deny, and nothing or
`true` to allow. A denial goes back to the model, and `execute` never runs.
Return `{input}` to run the tool with that input instead.

```ts
const booking = agent<{hotelId: string; quotedTotalCents: number; maxTotalCents: number}>({
  model,
  tools: {
    bookHotel: asyncTool({
      description: "Book the quoted hotel. The application supplies the price.",
      input: z.object({hotelId: z.string()}), // the model cannot set the price
      *before({hotelId}, {context}) {
        if (hotelId !== context.hotelId) return "Only the quoted hotel can be booked";
        if (context.quotedTotalCents > context.maxTotalCents) return "The quote exceeds the budget";
      },
      async execute({hotelId}, {context}) {
        return await reserve(hotelId, context.quotedTotalCents);
      },
    }),
  },
});
yield* booking.run(question, {context: {hotelId, quotedTotalCents, maxTotalCents}});
```

## Agent-level guardrails

| Hook                       | Runs                        | Return                                                              |
| -------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `beforeRun(messages, ctx)` | Once, before the first step | deny with `string`/`false`, or `{message}` to record instead        |
| `beforeStep(request, ctx)` | Before each model call      | deny with `string`/`false`, or `{messages}` to send instead         |
| `beforeTool(call, ctx)`    | Before every tool call      | deny with `string`/`false`, or `{input}` to run with instead        |
| `afterTool(output, ctx)`   | After every tool call       | the (possibly redacted) output                                      |
| `afterRun(candidate, ctx)` | On the final result         | nothing to accept, `{output}` to replace, or throw `GuardrailError` |

A hook never edits what it receives; it returns the replacement. Recorded messages
and tool calls are frozen, so editing them in place throws a `TypeError`.

| To                                           | Use                                  | History keeps                                      |
| -------------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| Redact the user's message before it is saved | `beforeRun` → `{message}`            | the replacement; the original is never recorded    |
| Change what one model call sees              | `beforeStep` → `{messages}`          | the originals; the change is for that request only |
| Change a tool's arguments                    | `beforeTool` or `before` → `{input}` | the model's call, and the result of the new input  |
| Redact tool output                           | `afterTool` → the new output         | the replacement; the original is never recorded    |
| Replace the final answer                     | `afterRun` → `{output}`              | the replacement; the candidate is never recorded   |

History means the run's messages: what the model sees in later steps,
`result.messages`, and the saved conversation. So `beforeRun`, `afterTool` and
`afterRun` are the places for redaction that must last; a `beforeStep` change is
gone on the next step.

A changed tool input is not recorded. In later steps the model sees its own call
next to a result from different arguments, and cannot tell they changed. That suits
keeping data from a tool: the model asked about `ada@example.com`, the tool searched
for `[email]`. The model's call still holds the original, so this does not remove it
from history. For other changes, say so in the tool's result, or the model may be
confused by it.

```ts
*beforeStep({messages}) {
  return {
    messages: messages.map((m) =>
      m.role === "user" ? {...m, content: redact(m.content)} : m,
    ),
  };
}
```

Keep the messages you do not change: the SDK validates only new ones, then checks
that every tool call still has its result. Input from `beforeTool` is validated
against the tool's schema like the model's. The history keeps the model's original
tool call. A denial in `beforeRun` or `beforeStep` fails the run; a denial in
`beforeTool` or `before` goes back to the model. For a sub-agent called through
`agentTool`, `beforeRun` is the place to check or redact the input the parent model
sends.

If `beforeTool` or `afterTool` throws a terminal error, for example because a
policy model is down, the call is blocked and the model gets an error with
code `guardrail_failed`. A throwing `afterRun` fails the run.

A hook can also ask a human first: `ctx.approve(call.input, {question,
details})` waits for the decision. `details` is any JSON value, such as the
policy that asked; it reaches `onApproval` and `onHumanApproval` on the
request.

Lesson 08 uses `afterRun` to reject a research finding that cites a source
the worker never read. The tool records reads in `context`, and `afterRun`
compares them with the cited IDs.
