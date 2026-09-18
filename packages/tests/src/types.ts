import {agent, tool, type ToolContext, type Model, type OutputDecision} from "@restate-agents/core";
import {z} from "zod";
import type {Context as RestateContext} from "@restatedev/restate-sdk";
import * as promise from "@restate-agents/promise";

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

declare const ctx: RestateContext;
const promiseAgent = promise.agent<TenantContext>({
  model,
  onApproval(request, ctx, context) {
    const tenant: string = context.tenant;
    return ctx.run(`Publish ${request.signalName}`, () => {
      void tenant;
    });
  },
  onUpdate(update, ctx, context) {
    const tenant: string = context.tenant;
    return ctx.run(`Observe ${update.type}`, () => {
      void tenant;
    });
  },
  tools: {
    asyncLookup: promise.asyncTool({
      description: "Lookup through an ordinary async API",
      input: z.object({id: z.string()}),
      async execute(input, metadata: promise.AsyncToolContext<TenantContext>) {
        const id: string = input.id;
        const signal: AbortSignal = metadata.signal;
        // @ts-expect-error Journaled async callbacks cannot perform SDK operations.
        metadata.run("nested", () => id);
        return {id, tenant: metadata.context.tenant, aborted: signal.aborted};
      },
    }),
    lookup: promise.tool({
      description: "Lookup",
      input: z.object({id: z.string()}),
      before({id}) {
        if (!id) return "An ID is required";
      },
      execute({id}, ctx, metadata: promise.ToolContext<TenantContext>) {
        // @ts-expect-error Promise metadata does not expose generator operations.
        metadata.progress(id);
        return ctx.run("lookup", () => ({id, tenant: metadata.context.tenant}));
      },
      after(output, ctx) {
        return ctx.run("inspect", () => output);
      },
    }),
  },
});
void promiseAgent.run(ctx, "Go", {context: {tenant: "a"}});
// @ts-expect-error Application context remains required by the promise entry point.
void promiseAgent.run(ctx, "Go");
// @ts-expect-error Application context fields remain checked.
void promiseAgent.run(ctx, "Go", {context: {tenant: 3}});
void promise.agent({model}).run(ctx, "Go");
void promiseAgent.run(ctx, "Go", {
  context: {tenant: "a"},
  onApproval(request, _ctx, context) {
    const tenant: string = context.tenant;
    const approval: promise.ApprovalRequest = request;
    void tenant;
    void approval;
  },
  onUpdate(update, _ctx, context) {
    const tenant: string = context.tenant;
    const event: promise.AgentUpdate = update;
    void tenant;
    void event;
  },
});
promise.agent({
  model,
  // @ts-expect-error Update hooks must return synchronously or return a RestatePromise.
  async onUpdate() {},
});
void promise.agent({model}).run(ctx, "Go", {
  // @ts-expect-error Generator update hooks belong to the gensdk entry point.
  *onUpdate() {},
});
promise.agent({
  model,
  // @ts-expect-error Approval hooks must return synchronously or return a RestatePromise.
  async onApproval() {},
});
void promise.agent({model}).run(ctx, "Go", {
  // @ts-expect-error Generator approval hooks belong to the gensdk entry point.
  *onApproval() {},
});
agent({
  model,
  // @ts-expect-error Approval notifications do not return the approval decision.
  *onApproval() {
    return true;
  },
});
promise.tool({
  description: "Invalid native promise",
  input: z.object({}),
  // @ts-expect-error Async wrappers erase RestatePromise's durable scheduling contract.
  async execute() {
    return "value";
  },
});
promise.tool({
  description: "Invalid coroutine hook",
  input: z.object({}),
  // @ts-expect-error Promise tool hooks do not accept coroutine operations.
  *before() {
    return true;
  },
  execute(_, ctx) {
    return ctx.run("value", () => "value");
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
