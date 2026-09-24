# Multiple agents

Lessons:
[05_evaluator_optimizer.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/05_evaluator_optimizer.ts),
[07_racing_agents.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/07_racing_agents.ts),
[08_research_report.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/08_research_report.ts),
[12_routing.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/12_routing.ts),
[15_peer_review_rpc.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/15_peer_review_rpc.ts)

Multi-agent systems are ordinary Restate composition. The handler decides
the control flow in plain code. Agents are steps that return typed output.

## Choose the boundary

| Shape                                                      | Use                                             | Each agent is                                                  |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Code decides the flow                                      | Run several agents in one handler               | a step in one invocation                                       |
| The model decides to delegate a subtask                    | `agentTool(subAgent, {description})`            | a tool call; fresh history; result returned to the parent      |
| The model hands over the conversation                      | `handoff(specialist)`                           | the same run, continued by another agent with the full history |
| Independent, retried, observable, or owned by another team | One Restate service per agent, `restate.client` | a separate durable invocation                                  |

## Route, then answer

```ts
const route = agent({
  model,
  instructions: "Choose the one specialist best suited to the question. Classify only.",
  output: z.object({specialist: z.enum(["billing", "account", "product"])}),
});
const specialists = {billing: agent({...}), account: agent({...}), product: agent({...})};

function* (question) {
  const routed = yield* route.run(question);
  if (routed.status !== "completed") throw new TerminalError(`Router ${routed.status}`);
  const {specialist} = routed.output;
  return replyText(yield* specialists[specialist].run(question));
}
```

## Draft and review, bounded

Loop over two structured agents. Give each run a distinct `name` so their
journal entries and approval signals stay apart.

```ts
for (let i = 1; i <= 3; i++) {
  const draft = yield* writer.run(JSON.stringify({task, previousCode: code, feedback}), {
    name: `write-${i}`,
  });
  if (draft.status !== "completed") throw new TerminalError(`Writer ${draft.status}`);
  code = draft.output.code;
  const review = yield* reviewer.run(JSON.stringify({task, code}), {name: `review-${i}`});
  if (review.status !== "completed") throw new TerminalError(`Reviewer ${review.status}`);
  if (review.output.approved) return code;
  feedback = review.output.feedback;
}
```

## Race, keep the first success

```ts
function* answerWith(name: string, candidate: Agent<undefined>, question: string) {
  const result = yield* candidate.run(question, {name});
  if (result.status !== "completed") throw new TerminalError(`${name} ${result.status}`);
  return result.output;
}

const tasks = Object.entries(candidates).map(([name, c]) =>
  restate.spawn(answerWith(name, c, question)),
);
try {
  return yield* restate.any(tasks); // a fast failure does not win
} finally {
  for (const task of tasks) task.interrupt(); // cancel the loser's model call and tools
  yield* restate.allSettled(tasks); // join so cleanup runs
}
```

## Orchestrator and workers over RPC

Make the worker a service. The orchestrator fans out typed calls and
synthesizes the results. Each worker has its own journal, retries, and entry
in the UI. Cancelling the orchestrator cancels the unfinished workers.

```ts
export const researchWorker = restate.service({
  name: "ResearchWorker",
  handlers: {
    *research({question, sources}: WorkerInput) {
      const result = yield* researcher.run(question, {
        context: {sources, readSourceIds: new Set()},
      });
      if (result.status !== "completed") throw new TerminalError(`Research ${result.status}`);
      return result.output;
    },
  },
});

// in ResearchReport.generate:
const plan = yield* planner.run(topic);
if (plan.status !== "completed") throw new TerminalError(`Planner ${plan.status}`);
const findings = yield* restate.all(
  plan.output.questions.map((question) =>
    restate.client(researchWorker).research({question, sources}),
  ),
);
const report = yield* writer.run(JSON.stringify({topic, findings}));
if (report.status !== "completed") throw new TerminalError(`Writer ${report.status}`);
return report.output;
```

## Agents exchanging messages

Lesson 15 has an author service and a reviewer service, plus a lead that
passes drafts and feedback between them as typed request and response
bodies. No mailbox or agent-to-agent protocol is needed: durable RPC is the
channel, and a replay never repeats a completed exchange.

## Sub-agents and handoffs inside one run

```ts
const lead = agent({
  model,
  tools: {
    research: agentTool(researcher, {description: "Research one question in depth."}),
    toBilling: handoff(billing, "Transfer billing questions to the billing specialist."),
  },
});
```

- **`agentTool`**: the sub-agent gets the task as a fresh conversation plus
  the parent's `context`. Its answer becomes the tool result. Its approvals
  and progress flow through the parent. Pass `background: true` to let the
  parent keep working meanwhile.
- **`handoff`**: after the current tool batch settles, the target agent's
  instructions and tools take over the same run and history. Run-level
  tools stay available.
