import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  tool,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@restate-agents/core";
import {z} from "zod";
import {testContext} from "./helpers.js";

// Providers cache a request's prefix: its tools, its instructions, then its
// messages. A step that changes any of them, or rewrites an earlier message,
// pays for the whole view again. These runs check that each request keeps
// the previous one as its prefix.

const context = () => testContext("prompt-prefix");
const lookup = tool({
  description: "Look up an order",
  input: z.object({id: z.string()}),
  *execute({id}) {
    return {id, status: "shipped"};
  },
});
const dump = tool({
  description: "Dump a log",
  input: z.object({}),
  *execute() {
    return "x".repeat(60_000);
  },
});
const calls = (...ids: string[]): ModelResponse => ({
  type: "tool_calls",
  calls: ids.map((id) => ({id, name: id.startsWith("d") ? "dump" : "lookup", input: {id}})),
});

function assertExtends(requests: ModelRequest[]) {
  for (const [i, next] of requests.entries()) {
    const previous = requests[i - 1];
    if (!previous) continue;
    assert.deepEqual(next.tools, previous.tools, `request ${i + 1} changed the tools`);
    assert.equal(next.instructions, previous.instructions);
    assert.deepEqual(
      next.messages.slice(0, previous.messages.length),
      previous.messages,
      `request ${i + 1} rewrote an earlier message`,
    );
  }
}

function recording(script: (step: number) => ModelResponse): {
  requests: ModelRequest[];
  model: Model;
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: function* (request: ModelRequest) {
      requests.push(structuredClone(request));
      return script(requests.length);
    },
  };
}

void test("parallel calls and a previewed result keep the previous request as prefix", async () => {
  const {requests, model} = recording((step): ModelResponse => {
    if (step === 1) return calls("a", "b", "c");
    if (step === 2) return calls("d1");
    return {type: "final", text: "Done"};
  });
  const a = agent({instructions: "Help.", tools: {lookup, dump}, model});
  await r.execute(context(), a.run("Go"));
  assert.equal(requests.length, 3);
  assertExtends(requests);
});

void test("a rejected structured answer stays in the prefix for the retry", async () => {
  const {requests, model} = recording((step): ModelResponse => {
    if (step === 1) return calls("a");
    return {type: "final", text: "", output: step === 2 ? {wrong: true} : {status: "shipped"}};
  });
  const a = agent({
    instructions: "Help.",
    tools: {lookup},
    output: z.object({status: z.string()}),
    model,
  });
  await r.execute(context(), a.run("Status?"));
  assert.equal(requests.length, 3);
  assertExtends(requests);
});

void test("the next turn extends the previous turn's last request", async () => {
  const {requests, model} = recording((step) =>
    step % 2 ? calls(`t${step}`) : {type: "final", text: "Done"},
  );
  const a = agent({instructions: "Help.", tools: {lookup}, model});
  const first = await r.execute(context(), a.run("First"));
  await r.execute(context(), a.run("Second", {messages: first.messages as Message[]}));
  assert.equal(requests.length, 4);
  assertExtends(requests);
});
