import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import * as restate from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {ToolError} from "@restate-agents/core";
import {
  agent,
  asyncTool,
  type ApprovalHandler,
  type AsyncToolContext,
  type UpdateHandler,
} from "@restate-agents/promise";
import {z} from "zod";

type Scenario = "success" | "error" | "denied";
type TestContext = {tenant: string; scenario: Scenario};
const effects = new Map<Scenario, number>();
type UpdateContext = {tenant: string};
type ObservedUpdate = {source: "agent" | "run"; tenant: string; invocationId: string; id: string};
const observedUpdates: ObservedUpdate[] = [];
type ApprovalContext = {tenant: string; approved: boolean};
type ObservedApproval = {source: "agent" | "run" | "tool"; tenant: string};
const observedApprovals: ObservedApproval[] = [];

const approvalAgent = agent<ApprovalContext>({
  *model(request) {
    if (request.messages.some((message) => message.role === "tool"))
      return {type: "final", text: "Done"};
    return {
      type: "tool_calls",
      calls: [{id: "close", name: "closeTicket", input: {ticketId: "T-42"}}],
    };
  },
  tools: {
    closeTicket: asyncTool({
      description: "Close a ticket after approval",
      input: z.object({ticketId: z.string()}),
      needsApproval: true,
      async execute({ticketId}, {context}: AsyncToolContext<ApprovalContext>) {
        const events = observedApprovals.filter((event) => event.tenant === context.tenant);
        assert.deepEqual(
          events.map((event) => event.source),
          ["agent", "run"],
        );
        observedApprovals.push({source: "tool", tenant: context.tenant});
        return {ticketId};
      },
    }),
  },
  onApproval(request, ctx, {tenant}) {
    assert.equal(request.invocationId, ctx.request().id);
    return ctx.run("Publish agent approval", () => {
      observedApprovals.push({source: "agent", tenant});
    });
  },
});

const updateAgent = agent<UpdateContext>({
  *model() {
    return {type: "final", text: "Done"};
  },
  onUpdate(update, ctx, {tenant}) {
    const invocationId = ctx.request().id;
    return ctx.run(`agent-update-${update.sequence}`, () => {
      observedUpdates.push({source: "agent", tenant, invocationId, id: update.id});
    });
  },
});

const assistant = agent<TestContext>({
  tools: {
    lookup: asyncTool({
      description: "Look up a record",
      input: z.object({id: z.string()}),
      describe: ({id}) => ({name: "Look up record", details: {id}}),
      before(_input, ctx, metadata) {
        return ctx.run("Check permission", () => metadata.context.scenario !== "denied");
      },
      needsApproval(_input, ctx) {
        return ctx.run("Check approval policy", () => false);
      },
      async execute({id}, metadata: AsyncToolContext<TestContext>) {
        const {scenario, tenant} = metadata.context;
        effects.set(scenario, (effects.get(scenario) ?? 0) + 1);
        assert.ok(metadata.signal instanceof AbortSignal);
        assert.equal(metadata.signal.aborted, false);
        assert.equal(metadata.callId, "lookup-1");
        assert.equal(metadata.name, "test-run");
        assert.equal(metadata.step, 1);
        assert.ok(metadata.invocationId.startsWith("inv_"));
        if (scenario === "error") throw new ToolError("Record is missing", "not_found");
        return {id, tenant};
      },
      after(output, ctx) {
        return ctx.run("Review result", () => ({record: output, reviewed: true}));
      },
    }),
  },
  *model(request) {
    if (request.messages.some((message) => message.role === "tool"))
      return {type: "final", text: "Done"};
    return {
      type: "tool_calls",
      calls: [{id: "lookup-1", name: "lookup", input: {id: "T-42"}}],
    };
  },
});

const harness = restate.service({
  name: "PromiseAsyncTools",
  handlers: {
    async approval(ctx: restate.Context, context: ApprovalContext) {
      return await approvalAgent.run(ctx, "Close T-42", {
        context,
        onApproval(request, boundContext, current) {
          assert.equal(boundContext, ctx);
          assert.deepEqual(current, context);
          assert.deepEqual(request.call.input, {ticketId: "T-42"});
          // A decision arriving before the SDK begins waiting must be retained.
          ctx
            .invocation(restate.InvocationIdParser.fromString(request.invocationId))
            .signal(request.signalName)
            .resolve(context.approved);
          return ctx.run("Publish run approval", () => {
            observedApprovals.push({source: "run", tenant: context.tenant});
          });
        },
      });
    },
    async invalidApproval(ctx: restate.Context) {
      const invalid = (async () => {}) as unknown as ApprovalHandler<ApprovalContext>;
      return await approvalAgent.run(ctx, "Close T-42", {
        context: {tenant: "invalid", approved: true},
        onApproval: invalid,
      });
    },
    async updates(ctx: restate.Context, tenant: string) {
      return await updateAgent.run(ctx, "Go", {
        context: {tenant},
        onUpdate(update, boundContext, context) {
          assert.equal(boundContext, ctx);
          assert.equal(context.tenant, tenant);
          const invocationId = boundContext.request().id;
          return boundContext.run(`run-update-${update.sequence}`, () => {
            const previous = observedUpdates.filter((event) => event.tenant === tenant).at(-1);
            assert.equal(previous?.source, "agent");
            assert.equal(previous.id, update.id);
            observedUpdates.push({source: "run", tenant, invocationId, id: update.id});
          });
        },
      });
    },
    async invalidUpdate(ctx: restate.Context) {
      // Exercise the runtime boundary for untyped callers too.
      const invalid = (async () => {}) as unknown as UpdateHandler<UpdateContext>;
      return await updateAgent.run(ctx, "Go", {context: {tenant: "invalid"}, onUpdate: invalid});
    },
    async run(ctx: restate.Context, scenario: Scenario) {
      return await assistant.run(ctx, "Look up T-42", {
        name: "test-run",
        context: {tenant: "private-tenant", scenario},
      });
    },
  },
});

let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [harness],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});

void test("promise approval hooks publish durably before execution and preserve early decisions", async () => {
  const client = connect({url: env.baseUrl()}).serviceClient(harness);
  const contexts: ApprovalContext[] = [
    {tenant: "approved", approved: true},
    {tenant: "denied", approved: false},
  ];
  const results = await Promise.all(contexts.map((context) => client.approval(context)));
  for (const [index, context] of contexts.entries()) {
    const expected = ["agent", "run"];
    if (context.approved) expected.push("tool");
    assert.deepEqual(
      observedApprovals
        .filter((event) => event.tenant === context.tenant)
        .map((event) => event.source),
      expected,
    );
    assert.equal(results[index].status, "completed");
    assert.equal(
      results[index].messages.find((message) => message.role === "tool")?.result.status,
      context.approved ? "success" : "denied",
    );
  }
});

void test("promise approval hooks reject native promises before executing the tool", async () => {
  await assert.rejects(
    async () => await connect({url: env.baseUrl()}).serviceClient(harness).invalidApproval(),
    /Promise hooks must return a value or a RestatePromise/,
  );
  assert.ok(
    !observedApprovals.some((event) => event.tenant === "invalid" && event.source === "tool"),
  );
});

void test("promise update hooks await durable work in order and isolate concurrent run contexts", async () => {
  const client = connect({url: env.baseUrl()}).serviceClient(harness);
  const tenants = ["one", "two"];
  const results = await Promise.all(tenants.map((tenant) => client.updates(tenant)));
  assert.ok(results.every((result) => result.status === "completed"));
  for (const tenant of tenants) {
    const events = observedUpdates.filter((event) => event.tenant === tenant);
    assert.deepEqual(
      events.map((event) => event.source),
      ["agent", "run", "agent", "run"],
    );
    assert.equal(new Set(events.map((event) => event.invocationId)).size, 1);
    assert.equal(new Set(events.map((event) => event.id)).size, 2);
    assert.ok(events.every((event) => event.id.startsWith(`${event.invocationId}:`)));
  }
});

void test("promise update hooks reject native promises", async () => {
  await assert.rejects(
    async () => await connect({url: env.baseUrl()}).serviceClient(harness).invalidUpdate(),
    /Promise hooks must return a value or a RestatePromise/,
  );
});

void test("promise asyncTool preserves context, adapts SDK hooks, and journals execution once", async () => {
  const result = await connect({url: env.baseUrl()}).serviceClient(harness).run("success");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.messages.find((message) => message.role === "tool")?.result, {
    status: "success",
    output: {record: {id: "T-42", tenant: "private-tenant"}, reviewed: true},
  });
  assert.equal(effects.get("success"), 1);
});

void test("promise asyncTool preserves business errors across forced replay", async () => {
  const result = await connect({url: env.baseUrl()}).serviceClient(harness).run("error");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.messages.find((message) => message.role === "tool")?.result, {
    status: "error",
    code: "not_found",
    message: "Record is missing",
  });
  assert.equal(effects.get("error"), 1);
});

void test("promise asyncTool enforces its guard before starting ordinary I/O", async () => {
  const result = await connect({url: env.baseUrl()}).serviceClient(harness).run("denied");
  assert.equal(result.status, "completed");
  assert.equal(result.messages.find((message) => message.role === "tool")?.result.status, "denied");
  assert.equal(effects.get("denied") ?? 0, 0);
});
