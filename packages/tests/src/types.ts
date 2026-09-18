import {agent, tool, type ToolContext, type Model, type OutputDecision} from "@restate-agents/core";
import {z} from "zod";

// Compile-only examples verify the public type boundary.
type TenantContext = {tenant: string};

const model: Model = function* () {
  return {type: "final", text: "Done"};
};
const a = agent<TenantContext>({
  model,
  tools: {
    lookup: tool({
      input: z.object({id: z.string()}),
      description: "Lookup",
      *execute(input, ctx: ToolContext<TenantContext>) {
        const id: string = input.id;
        // @ts-expect-error The schema infers string, not number.
        const wrong: number = input.id;
        void wrong;
        return {id, tenant: ctx.context.tenant};
      },
    }),
  },
});
a.run("Go", {context: {tenant: "a"}});
// @ts-expect-error A typed context is required on each run.
a.run("Go");
// @ts-expect-error Context fields are checked.
a.run("Go", {context: {tenant: 3}});
agent({model}).run("Go");

agent({
  model,
  output: z.object({answer: z.string(), sources: z.array(z.object({id: z.string()}))}),
  *afterRun(candidate) {
    // @ts-expect-error A policy may inspect lifecycle facts, not change them.
    candidate.steps = 10;
    // @ts-expect-error Candidate history is read-only, including its array.
    candidate.messages.push({role: "user", content: "forged"});
    if (candidate.status === "completed") {
      // @ts-expect-error Nested candidate output is read-only too.
      candidate.output.sources[0].id = "forged";
      return {output: {...candidate.output, answer: candidate.output.answer.toUpperCase()}};
    }
    return {output: "Work stopped before an answer was accepted"};
  },
});

const lifecycleRewrite = {status: "completed" as const, output: "answer"};
// @ts-expect-error Lifecycle fields are forbidden even when the value is not an object literal.
const forbiddenDecision: OutputDecision = lifecycleRewrite;
void forbiddenDecision;

agent({
  model,
  output: z.tuple([z.string(), z.number()]).rest(z.boolean()),
  *afterRun(candidate) {
    if (candidate.status === "completed") {
      const label: string = candidate.output[0];
      const score: number = candidate.output[1];
      const flag: boolean = candidate.output[2];
      // Immutable replacements preserve tuple positions and the variadic element type.
      return {output: [label.toUpperCase(), score, flag] as const};
    }
  },
});

agent<undefined>({
  model,
  // @ts-expect-error A full candidate cannot be returned as an output decision.
  *afterRun(candidate) {
    return candidate;
  },
});
