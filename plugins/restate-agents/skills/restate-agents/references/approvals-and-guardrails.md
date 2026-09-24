# Approvals and guardrails

Lessons:
[06_human_approval.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/06_human_approval.ts),
[13_tool_guardrail.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/13_tool_guardrail.ts),
[08_research_report.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/08_research_report.ts) (`afterRun`)

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
        return replyText(result);
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
| `beforeRun(messages, ctx)` | Once, before the first step | deny with `string`/`false`                                          |
| `beforeStep(request, ctx)` | Before each model call      | deny with `string`/`false`                                          |
| `beforeTool(call, ctx)`    | Before every tool call      | deny with `string`/`false`                                          |
| `afterTool(output, ctx)`   | After every tool call       | the (possibly redacted) output                                      |
| `afterRun(candidate, ctx)` | On the final result         | nothing to accept, `{output}` to replace, or throw `GuardrailError` |

Lesson 08 uses `afterRun` to reject a research finding that cites a source
the worker never read. The tool records reads in `context`, and `afterRun`
compares them with the cited IDs.
