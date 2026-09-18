import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import * as restate from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {ToolError} from "@restate-agents/core";
import {agent, asyncTool, type AsyncToolContext} from "@restate-agents/promise";
import {z} from "zod";

type Scenario = "success" | "error" | "denied";
type TestContext = {tenant: string; scenario: Scenario};
const effects = new Map<Scenario, number>();

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
