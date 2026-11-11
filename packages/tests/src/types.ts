import {
  agent,
  tool,
  serviceTool,
  type ToolContext,
  type Model,
  type OutputDecision,
} from "@restatedev/agentlib";
import {z} from "zod";
import * as r from "@restatedev/restate-sdk-gen";

// Compile-only examples verify the public type boundary.
type TenantContext = {tenant: string};

const model: Model = function* () {
  return {type: "final", text: "Done"};
};
const a = agent<TenantContext>({
  model,
  *onApproval(request, context) {
    const tenant: string = context.tenant;
    const invocationId: string = request.invocationId;
    void tenant;
    void invocationId;
  },
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
a.run("Go", {
  context: {tenant: "a"},
  *onApproval(request, context) {
    const tenant: string = context.tenant;
    const signalName: string = request.signalName;
    void tenant;
    void signalName;
  },
});
// @ts-expect-error A typed context is required on each run.
a.run("Go");
// @ts-expect-error Context fields are checked.
a.run("Go", {context: {tenant: 3}});
agent({model}).run("Go");

agent({
  model,
  // @ts-expect-error Approval notifications do not return the approval decision.
  *onApproval() {
    return true;
  },
});
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

// ---------------------------------------------------------------------------
// serviceTool — compile-time contracts.
// ---------------------------------------------------------------------------
const refundIface = r.iface.service("Refund", {
  process: r.iface.schemas({
    input: z.object({orderId: z.string()}),
    output: z.object({ok: z.boolean()}),
  }),
  status: r.iface.json<void, string>(),
});
const counterIface = r.iface.object("Counter", {
  add: r.iface.schemas({input: z.number(), output: z.number()}),
});

// serviceTool always yields a single Tool: a multiplexed one from a bare interface, and
// a handler-scoped one from options. Both compose into an agent's tools record.
agent<TenantContext>({
  model,
  tools: {
    refund: serviceTool(refundIface),
    pippo: serviceTool({iface: refundIface, handler: "process"}),
  },
});

// @ts-expect-error "nope" is not a handler of the interface.
serviceTool({iface: refundIface, handler: "nope"});
// @ts-expect-error services do not take a key.
serviceTool({iface: refundIface, handler: "process", key: "k"});
// @ts-expect-error a bare object interface still needs a key.
serviceTool(counterIface);
// @ts-expect-error object tools require a key.
serviceTool({iface: counterIface, handler: "add"});
// Object tools accept a static key or a resolver, and may be multiplexed with a key.
serviceTool({iface: counterIface, key: "c-1"});
serviceTool({iface: counterIface, handler: "add", key: "c-1"});
serviceTool({iface: counterIface, handler: "add", key: (input) => JSON.stringify(input)});

agent<undefined>({
  model,
  // @ts-expect-error Only {input} replaces a tool call's input.
  *beforeTool() {
    return {query: "x"};
  },
});

agent<undefined>({
  model,
  *beforeTool(call) {
    if (call.name === "delete") return "Deleting is not allowed";
    if (call.name === "search") return {input: {query: "[redacted]"}};
  },
});
