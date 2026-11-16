import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  tool,
  type Agent,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from "@restatedev/agentlib";
import {testContext} from "./helpers.js";

const execute = <T>(operation: r.Operation<T>) => r.execute(testContext("fork"), operation);
const read = tool({
  description: "Read a page",
  input: z.object({}),
  *execute() {
    return "page";
  },
});
const call = (id: string, name: string, input: {[key: string]: string} = {}): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name, input}],
});
const final = (text: string): ModelResponse => ({type: "final", text});
const isFork = (request: ModelRequest) => {
  const first = request.messages.findLast((message) => message.role === "user");
  return first?.role === "user" && first.content.startsWith("[Forked sub-agent]");
};
const toolResult = (messages: readonly Message[], callId: string) =>
  messages.find((message) => message.role === "tool" && message.callId === callId);

/** A lead whose `delegate` tool forks the lead itself. */
function forkingLead(model: (request: ModelRequest) => ModelResponse): Agent<undefined, string> {
  const lead: Agent<undefined, string> = agent({
    tools: {
      read,
      delegate: agentTool(
        {run: (input, options) => lead.run(input, options)},
        {
          description: "Fork yourself to do a subtask",
          fork: true,
        },
      ),
    },
    *model(request) {
      return model(request);
    },
  });
  return lead;
}

void test("a fork starts from the parent's latest request, followed by the task", async () => {
  const forkRequests: ModelRequest[] = [];
  const leadRequests: ModelRequest[] = [];
  const lead = forkingLead((request) => {
    if (isFork(request)) {
      forkRequests.push(request);
      return final("fork done");
    }
    leadRequests.push(request);
    if (request.step === 1) return call("r1", "read");
    if (request.step === 2) return call("d1", "delegate", {task: "Summarize the page"});
    return final("Done");
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Done");

  const [fork] = forkRequests;
  assert.ok(fork);
  // The inherited messages are those of the request that chose to delegate, so the
  // delegating step's own call never appears without its result.
  const inherited = fork.messages.slice(0, -1);
  assert.deepEqual(inherited, leadRequests[1]!.messages);
  assert.equal(
    fork.messages.some(
      (m) => m.role === "assistant" && m.calls?.some((c) => c.name === "delegate"),
    ),
    false,
  );
  const task = fork.messages.at(-1);
  assert.ok(task?.role === "user" && task.content.endsWith("Task:\nSummarize the page"));
  // Same instructions and tools as the parent, so a provider can reuse its cached prefix.
  assert.deepEqual(
    fork.tools.map((t) => t.name),
    leadRequests[1]!.tools.map((t) => t.name),
  );
  assert.deepEqual(toolResult(result.messages, "d1"), {
    role: "tool",
    callId: "d1",
    name: "delegate",
    result: {status: "success", output: "fork done"},
  });
});

void test("a fork cannot fork again", async () => {
  let nested: Message | undefined;
  const lead = forkingLead((request) => {
    if (isFork(request)) {
      if (request.step === 1) return call("d2", "delegate", {task: "Go deeper"});
      nested = toolResult(request.messages, "d2");
      return final("did it myself");
    }
    if (request.step === 1) return call("d1", "delegate", {task: "Subtask"});
    return final("Done");
  });
  const result = await execute(lead.run("Go"));
  assert.equal(result.status, "completed");
  assert.ok(nested?.role === "tool");
  assert.equal(nested.result.status, "error");
  assert.match(nested.result.status === "error" ? nested.result.code : "", /fork_nested/);
});

void test("without fork, a sub-agent starts with only the task", async () => {
  let seen: ModelRequest | undefined;
  const worker = agent({
    *model(request) {
      seen = request;
      return final("worked");
    },
  });
  const lead = agent({
    tools: {read, delegate: agentTool(worker, {description: "Delegate"})},
    *model(request) {
      if (request.step === 1) return call("r1", "read");
      if (request.step === 2) return call("d1", "delegate", {task: "Subtask"});
      return final("Done");
    },
  });
  await execute(lead.run("Go"));
  assert.deepEqual(seen?.messages, [{role: "user", content: "Subtask"}]);
});
