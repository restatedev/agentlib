// Runs lesson 18 under the real AG-UI client, which verifies every event
// sequence it receives, against a Restate server. Node strips this file's
// types itself: under tsx, @ag-ui/client's fast-json-patch dependency
// resolves to the TypeScript source it ships and fails to load.
import assert from "node:assert/strict";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {after, before, mock, test} from "node:test";
import {HttpAgent} from "@ag-ui/client";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import type {Model, ModelResponse} from "@restate-agents/core";

// Status questions look the order up; anything else cancels it.
const orders: Model = function* (request): Generator<never, ModelResponse> {
  const last = request.messages.at(-1)!;
  if (last.role === "tool") {
    if (last.result.status !== "success")
      return {type: "final", text: "Order O-7 was left unchanged."};
    const {status} = last.result.output as {status: string};
    return {type: "final", text: `Order O-7 is ${status}.`};
  }
  const name =
    last.role === "user" && last.content.includes("status") ? "lookupOrder" : "cancelOrder";
  // Call IDs stay unique across the thread's turns.
  const turn = request.messages.filter((message) => message.role === "user").length;
  return {type: "tool_calls", calls: [{id: `${name}-${turn}`, name, input: {orderId: "O-7"}}]};
};
mock.module("@restate-agents/core/openai", {namedExports: {openAIModel: () => orders}});
const {agUiThread, agUiHandler} = await import("@restate-agents/examples/ag-ui");

let env: RestateTestEnvironment;
let server: Server;
let url: string;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [agUiThread],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
    server = createServer(agUiHandler(env.baseUrl()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },
  {timeout: 60000},
);
after(async () => {
  server?.close();
  await env?.stop();
});

function client(threadId: string, text: string) {
  const agent = new HttpAgent({url, threadId});
  agent.addMessage({id: crypto.randomUUID(), role: "user", content: text});
  return agent;
}

void test("a run streams the tool call, its result and the answer", {timeout: 30000}, async () => {
  const agent = client("status", "What is the status of order O-7?");
  const {newMessages} = await agent.runAgent();
  assert.deepEqual(
    agent.messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  const [call] = (agent.messages[1] as {toolCalls: {function: {name: string; arguments: string}}[]})
    .toolCalls;
  assert.equal(call!.function.name, "lookupOrder");
  assert.deepEqual(JSON.parse(call!.function.arguments), {orderId: "O-7"});
  // The tool result is JSON, which clients such as CopilotKit parse.
  assert.deepEqual(JSON.parse(agent.messages[2]!.content as string), {
    status: "success",
    output: {orderId: "O-7", status: "shipped"},
  });
  assert.equal(newMessages.at(-1)!.content, "Order O-7 is shipped.");
});

for (const approved of [true, false]) {
  void test(
    `an approval interrupts the run and a resume ${approved ? "approves" : "rejects"} it`,
    {timeout: 30000},
    async () => {
      const agent = client(`cancel-${approved}`, "Cancel order O-7.");
      await agent.runAgent();
      const [interrupt] = agent.pendingInterrupts;
      assert.equal(agent.pendingInterrupts.length, 1);
      assert.equal(interrupt!.toolCallId, "cancelOrder-1");

      // The turn waited in Restate with no stream open; the resume follows it on.
      const {newMessages} = await agent.runAgent({
        resume: [{interruptId: interrupt!.id, status: "resolved", payload: {approved}}],
      });
      assert.equal(agent.pendingInterrupts.length, 0);
      const result = agent.messages.find((message) => message.role === "tool");
      assert.equal(JSON.parse(result!.content as string).status, approved ? "success" : "denied");
      assert.equal(
        newMessages.at(-1)!.content,
        approved ? "Order O-7 is cancelled." : "Order O-7 was left unchanged.",
      );
    },
  );
}

void test("a thread keeps its conversation across runs", {timeout: 30000}, async () => {
  const agent = client("memory", "What is the status of order O-7?");
  await agent.runAgent();
  agent.addMessage({id: crypto.randomUUID(), role: "user", content: "And the status now?"});
  const {newMessages} = await agent.runAgent();
  assert.equal(newMessages.at(-1)!.content, "Order O-7 is shipped.");
  const state = env.stateOf(agUiThread, "memory");
  const messages = (await state.get<{role: string}[]>("messages"))!;
  assert.equal(messages.filter((message) => message.role === "user").length, 2);
});

void test("an answer to an interrupt that is not waiting fails the run", async () => {
  const agent = new HttpAgent({url, threadId: "nothing-pending"});
  const errors: string[] = [];
  await agent.runAgent(
    {resume: [{interruptId: "unknown", status: "resolved", payload: {}}]},
    {
      onRunErrorEvent({event}) {
        errors.push(event.message);
      },
    },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /not waiting for an answer/);
});
