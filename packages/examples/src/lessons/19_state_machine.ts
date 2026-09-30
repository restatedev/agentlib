// 19: Compose agents as a graph, the way LangGraph does, with a small runner.
//
// `graph` below is the lesson's own code, not an SDK API. Nodes read the state
// and return an update plus the next node, or several next nodes to run in
// parallel. Parallel branches see the same state; their updates merge when
// all of them finish, and the branches meet again where they name the same
// node. `edges` lists where each node may go, so TypeScript rejects a node
// that returns anything else, and the runner draws the graph from it.
//
// No checkpointer is needed: Restate journals every agent run and step inside
// a node, so a crash resumes mid-node rather than at the last node boundary.
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {Operation} from "@restatedev/restate-sdk-gen";
import {agent, type RunResult} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

// ---- The runner ----

const END = "end";
type Edges = Record<string, readonly string[]>;
type Step<S, Next> = {update?: Partial<S>; next: Next | readonly Next[]};
type Nodes<S, E extends Edges> = {
  [N in keyof E]: (state: Readonly<S>) => Operation<Step<S, E[N][number]>>;
};
/** How to merge a key that parallel branches may both update. */
type Reducers<S> = {[K in keyof S]?: (current: S[K], update: S[K]) => S[K]};

/** Call as `graph<State>()({...})`: the state type is given, the edges inferred. */
function graph<S extends object>() {
  // Every edge must lead to a node or to END.
  return <const E extends Edges & {[N in keyof E]: readonly (keyof E | typeof END)[]}>(spec: {
    start: keyof E & string;
    edges: E;
    nodes: Nodes<S, E>;
    reducers?: Reducers<S>;
    maxSteps?: number;
  }) => {
    const {start, edges, nodes, reducers = {}, maxSteps = 25} = spec;
    function merge(state: S, updates: (Partial<S> | undefined)[]): S {
      const next = {...state} as Record<string, unknown>;
      const written = new Set<string>();
      for (const [key, value] of updates.flatMap((update) => Object.entries(update ?? {}))) {
        const reduce = (reducers as Record<string, (a: unknown, b: unknown) => unknown>)[key];
        if (!reduce && written.has(key))
          throw new TerminalError(`Parallel branches both set "${key}"; give it a reducer`);
        written.add(key);
        next[key] = reduce ? reduce(next[key], value) : value;
      }
      return next as S;
    }
    return {
      /** Runs from `start` until every branch reaches "end"; returns the state and the steps taken. */
      *run(initial: S) {
        let state = initial;
        let frontier: string[] = [start];
        const path: string[][] = [];
        while (frontier.length > 0) {
          if (path.length === maxSteps)
            throw new TerminalError(`The graph did not finish within ${maxSteps} steps`);
          path.push(frontier);
          const steps = yield* restate.all(
            frontier.map((name) => restate.spawn(nodes[name as keyof E](state))),
          );
          state = merge(
            state,
            steps.map((step) => step.update),
          );
          const next = steps.flatMap(({next}) => (typeof next === "string" ? [next] : next));
          frontier = [...new Set(next)].filter((name) => name !== END);
        }
        return {state, path};
      },
      /** The graph as a Mermaid flowchart. */
      diagram: [
        "flowchart LR",
        ...Object.entries(edges).flatMap(([from, to]) => to.map((next) => `  ${from} --> ${next}`)),
      ].join("\n"),
    };
  };
}

// ---- The support graph ----

const MAX_DRAFTS = 3;
type State = {
  email: string;
  category?: "refund" | "question" | "complaint";
  notes: string[];
  reply?: string;
  feedback?: string;
  drafts: number;
};

const triager = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Triage the customer email into refund, question or complaint. Classify only.",
  output: z.object({category: z.enum(["refund", "question", "complaint"])}),
});
const policyReader = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Policy: in one sentence, state the demo company's refund policy that applies to the email: duplicate charges are refunded within 30 days.",
});
const writer = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Draft a short, polite reply to the customer email, using only the notes. When feedback on an earlier draft is supplied, revise that draft.",
});
const reviewer = agent({
  model,
  maxSteps: 2,
  instructions:
    "Graph lesson. Review the reply to the customer email. Approve it only if it answers the email and promises nothing the notes do not support.",
  output: z.object({approved: z.boolean(), feedback: z.string()}),
});

function* completed<T>(run: Operation<RunResult<T>>) {
  const result = yield* run;
  if (result.status !== "completed")
    throw new TerminalError(`Agent ${result.status}: ${result.reason}`);
  return result.output;
}

const support = graph<State>()({
  start: "triage",
  edges: {
    triage: ["policy", "history", "escalate"],
    policy: ["draft"],
    history: ["draft"],
    draft: ["review"],
    review: ["draft", END],
    escalate: [END],
  },
  // Both research branches add notes in the same step.
  reducers: {notes: (current, update) => [...current, ...update]},
  nodes: {
    *triage({email}) {
      const {category} = yield* completed(triager.run(email, {name: "triage"}));
      // Fan out: read the policy and the order history in parallel.
      return {
        update: {category},
        next: category === "complaint" ? "escalate" : ["policy", "history"],
      };
    },
    *policy({email}) {
      const policy = yield* completed(policyReader.run(email, {name: "policy"}));
      return {update: {notes: [`policy: ${policy}`]}, next: "draft"};
    },
    *history() {
      // A node need not be an agent: here it is one journaled lookup.
      const orders = yield* restate.run(async () => "O-7 was charged $40 twice on 2026-09-28", {
        name: "order history",
      });
      return {update: {notes: [`history: ${orders}`]}, next: "draft"};
    },
    // Fan in: both branches name draft, so it runs once, after both.
    *draft({email, notes, reply, feedback, drafts}) {
      const input = JSON.stringify({email, notes, draft: reply, feedback});
      // Distinct run names keep each draft's events and approvals apart.
      const next = yield* completed(writer.run(input, {name: `draft-${drafts + 1}`}));
      return {update: {reply: next, drafts: drafts + 1}, next: "review"};
    },
    *review({email, notes, reply, drafts}) {
      const input = JSON.stringify({email, notes, reply});
      const review = yield* completed(reviewer.run(input, {name: `review-${drafts}`}));
      const done = review.approved || drafts >= MAX_DRAFTS;
      return {update: {feedback: review.feedback}, next: done ? END : "draft"};
    },
    *escalate() {
      const reply = "Thank you for telling us. A member of our team will contact you today.";
      return {update: {reply}, next: END};
    },
  },
});

export const supportGraph = restate.service({
  name: "SupportGraph",
  handlers: {
    reply: restate.schemas(
      {
        input: z
          .string()
          .min(1)
          .meta({default: "I was charged twice for my order O-7. Can I get one charge back?"}),
        output: z.object({reply: z.string(), path: z.array(z.array(z.string()))}),
      },
      function* (email) {
        const {state, path} = yield* support.run({email, notes: [], drafts: 0});
        return {reply: state.reply!, path};
      },
    ),
    *diagram() {
      return support.diagram;
    },
  },
});
