import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {after, before, mock, test} from "node:test";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import type {Message, Model, ModelResponse} from "@restate-agents/core";

// The coding lesson against a real Restate server and a real Docker sandbox.
process.env.SANDBOX_PROVIDER = "docker";
process.env.SANDBOX_IMAGE = "node:24-slim";

const command = (id: string, command: string): ModelResponse => ({
  type: "tool_calls",
  calls: [{id, name: "executeCommand", input: {command}}],
});

// Turn 1 writes and runs a script; turn 2 finds it again in the same sandbox.
const coder: Model = function* (request) {
  const turn = request.messages.filter((message) => message.role === "user").length;
  const last = request.messages.at(-1) as Message;
  if (last.role === "user" && turn === 1)
    return {
      type: "tool_calls",
      calls: [
        {
          id: "write",
          name: "writeFile",
          input: {path: "primes.js", content: "console.log([2, 3, 5, 7].join(','));\n"},
        },
      ],
    };
  if (last.role === "tool" && last.callId === "write") return command("run", "node primes.js");
  if (last.role === "user") return command(`list-${turn}`, "ls");
  assert.equal(last.role, "tool");
  if (last.result.status !== "success") assert.fail("the command should succeed");
  const {stdout} = last.result.output as {stdout: string};
  return {type: "final", text: stdout.trim()};
};
mock.module("@restate-agents/core/openai", {namedExports: {openAIModel: () => coder}});
const {codingSession} = await import("@restate-agents/examples/gensdk/coding-agent");

const running = (id: string) => {
  try {
    return execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", id], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "gone";
  }
};

let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [codingSession],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 120000},
);
after(async () => {
  await env?.stop();
});

void test(
  "a coding session keeps its sandbox between turns and closes it",
  {timeout: 180000},
  async () => {
    const session = connect({url: env.baseUrl()}).client(codingSession, "alice");
    const state = env.stateOf(codingSession, "alice");

    assert.equal(await session.turn("Write a script that prints primes and run it."), "2,3,5,7");
    const sandboxId = await state.get<string>("sandbox");
    assert.ok(sandboxId);
    assert.equal(running(sandboxId), "true");

    assert.equal(await session.turn("What files are there?"), "primes.js");
    assert.equal(await state.get("sandbox"), sandboxId);

    assert.equal(await session.close(), true);
    assert.equal(await state.get("sandbox"), null);
    assert.equal(running(sandboxId), "gone");
  },
);
