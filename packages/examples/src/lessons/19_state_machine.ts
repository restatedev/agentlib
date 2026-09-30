// 19: Compose agents as a state machine, the way a LangGraph graph does.
//
// Each node is a generator that reads and updates the state, then returns the
// name of the next node. `edges` lists where each node may go, so TypeScript
// rejects a node that returns anything else, and the lesson can draw the graph.
// No checkpointer is needed: Restate journals every agent run inside a node, so
// a crash resumes mid-node rather than at the last node boundary.
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {Operation} from "@restatedev/restate-sdk-gen";
import {agent, type RunResult} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const MAX_DRAFTS = 3;

const edges = {
  triage: ["draft", "escalate"],
  draft: ["review"],
  review: ["draft", "end"],
  escalate: ["end"],
} as const;
type Node = keyof typeof edges;
type State = {
  email: string;
  category?: "refund" | "question" | "complaint";
  reply?: string;
  feedback?: string;
  drafts: number;
  path: Node[];
};

const triage = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Triage the customer email into refund, question or complaint. Classify only.",
  output: z.object({category: z.enum(["refund", "question", "complaint"])}),
});
const writer = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Draft a short, polite reply to the customer email. When feedback on an earlier draft is supplied, revise that draft.",
});
const reviewer = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Review the reply to the customer email. Approve it only if it answers the email and promises nothing the company has not confirmed.",
  output: z.object({approved: z.boolean(), feedback: z.string()}),
});

function* completed<T>(run: Operation<RunResult<T>>) {
  const result = yield* run;
  if (result.status !== "completed")
    throw new TerminalError(`Agent ${result.status}: ${result.reason}`);
  return result.output;
}

const nodes: {[N in Node]: (state: State) => Operation<(typeof edges)[N][number]>} = {
  *triage(state) {
    ({category: state.category} = yield* completed(triage.run(state.email)));
    return state.category === "complaint" ? "escalate" : "draft";
  },
  *draft(state) {
    state.drafts++;
    // Distinct run names keep each draft's events and approvals apart.
    const input = JSON.stringify({
      email: state.email,
      draft: state.reply,
      feedback: state.feedback,
    });
    state.reply = yield* completed(writer.run(input, {name: `draft-${state.drafts}`}));
    return "review";
  },
  *review(state) {
    const input = JSON.stringify({email: state.email, reply: state.reply});
    const review = yield* completed(reviewer.run(input, {name: `review-${state.drafts}`}));
    state.feedback = review.feedback;
    return review.approved || state.drafts >= MAX_DRAFTS ? "end" : "draft";
  },
  *escalate(state) {
    state.reply = "Thank you for telling us. A member of our team will contact you today.";
    return "end";
  },
};

/** The graph as a Mermaid flowchart. */
export const diagram = [
  "flowchart LR",
  ...Object.entries(edges).flatMap(([from, to]) => to.map((next) => `  ${from} --> ${next}`)),
].join("\n");

export const supportGraph = restate.service({
  name: "SupportGraph",
  handlers: {
    reply: restate.schemas(
      {
        input: z
          .string()
          .min(1)
          .meta({default: "I was charged twice for my order O-7. Can I get one charge back?"}),
        output: z.object({reply: z.string(), path: z.array(z.string())}),
      },
      function* (email) {
        const state: State = {email, drafts: 0, path: []};
        let node = "triage" as Node | "end";
        while (node !== "end") {
          state.path.push(node);
          node = yield* nodes[node](state);
        }
        return {reply: state.reply!, path: state.path};
      },
    ),
    *diagram() {
      return diagram;
    },
  },
});
