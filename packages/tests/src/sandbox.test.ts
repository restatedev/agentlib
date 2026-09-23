import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {channel, gen, type Channel} from "@restatedev/restate-sdk-gen";
import {agent, type Message, type ModelResponse, type ToolCall} from "@restate-agents/core";
import {
  lazySandbox,
  sandboxTools,
  type Sandbox,
  type SandboxToolsOptions,
} from "@restate-agents/core/sandbox";
import {runHandler} from "./replay-harness.mjs";

// A "sandbox" that is a temporary directory on this machine, with real `sh`.
const local: Sandbox = {
  exec(script, {signal}) {
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", script], {signal});
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({exitCode: exitCode ?? 1, stdout, stderr}));
    });
  },
  async readFile(path) {
    return existsSync(path) ? readFile(path, "utf8") : undefined;
  },
  async writeFile(path, content) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, content);
  },
};

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sandbox-test-"));
  await mkdir(join(root, "workspace"));
  const options = {
    workdir: join(root, "workspace"),
    stateDir: join(root, "state"),
  } satisfies SandboxToolsOptions;
  return {root, options, file: (name: string) => join(options.workdir, name)};
}

const until = (ready: () => boolean) =>
  r.run(
    async () => {
      while (!ready()) await delay(20);
    },
    {name: "wait for fixture"},
  );

const results = (messages: readonly Message[]) =>
  messages.flatMap((message) => (message.role === "tool" ? [message.result] : []));

/** An agent that makes each batch of calls in turn, then finishes. */
function scripted(options: SandboxToolsOptions, ...batches: ToolCall[][]) {
  return agent({
    tools: sandboxTools(options),
    *model(request): Generator<never, ModelResponse> {
      const calls = batches[(request.step ?? 1) - 1];
      return calls ? {type: "tool_calls", calls} : {type: "final", text: "done"};
    },
  });
}
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  input: input as ToolCall["input"],
});

/** Results in call order; calls in one batch may finish in any order. */
async function runCalls(options: SandboxToolsOptions, ...batches: ToolCall[][]) {
  const coder = scripted(options, ...batches);
  const {output} = await runHandler((ctx: Context) =>
    r.execute(ctx, coder.run("go", {context: {sandbox: local}})),
  );
  assert.equal(output.status, "completed");
  const byCall = new Map(
    (output.messages as Message[]).flatMap((message) =>
      message.role === "tool" ? [[message.callId, message.result] as const] : [],
    ),
  );
  return batches.flat().map((call) => byCall.get(call.id));
}

void test("file tools write, read with line numbers, and edit exact text", async () => {
  const {options, file} = await workspace();
  const [written, read, edited, missing, ambiguous] = await runCalls(
    options,
    [call("w", "writeFile", {path: "src/a.txt", content: "one\ntwo\ntwo\n"})],
    [call("r", "readFile", {path: "src/a.txt", offset: 2, limit: 1})],
    [call("e", "editFile", {path: "src/a.txt", oldText: "one", newText: "uno"})],
    [call("m", "editFile", {path: "src/a.txt", oldText: "three", newText: "tres"})],
    [call("a", "editFile", {path: "src/a.txt", oldText: "two", newText: "dos"})],
  );
  assert.deepEqual(written, {status: "success", output: {path: "src/a.txt", bytes: 12}});
  assert.deepEqual(read, {status: "success", output: "     2\ttwo\n[lines 2-2 of 4]"});
  assert.deepEqual(edited, {status: "success", output: {path: "src/a.txt", replacements: 1}});
  assert.equal(missing?.status === "error" && missing.code, "no_match");
  assert.equal(ambiguous?.status === "error" && ambiguous.code, "ambiguous_match");
  assert.equal(await readFile(file("src/a.txt"), "utf8"), "uno\ntwo\ntwo\n");
});

void test("reading a missing file is an error the model can handle", async () => {
  const {options} = await workspace();
  const [result] = await runCalls(options, [call("r", "readFile", {path: "nope.txt"})]);
  assert.equal(result?.status === "error" && result.code, "not_found");
});

void test("listFiles and search skip dependency folders", async () => {
  const {options, file} = await workspace();
  await mkdir(file("node_modules/pkg"), {recursive: true});
  await writeFile(file("node_modules/pkg/index.js"), "const needle = 1;\n");
  await mkdir(file("src"));
  await writeFile(file("src/main.ts"), "// needle here\nexport {};\n");
  const [listed, found, none] = await runCalls(options, [
    call("l", "listFiles", {}),
    call("s", "search", {pattern: "need+le"}),
    call("n", "search", {pattern: "haystack"}),
  ]);
  assert.deepEqual(listed, {status: "success", output: "src/main.ts\n"});
  assert.deepEqual(found, {status: "success", output: `${file("src/main.ts")}:1:// needle here\n`});
  assert.deepEqual(none, {status: "success", output: "No matches."});
});

void test("a failing command is a result, not an error", async () => {
  const {options} = await workspace();
  const [result] = await runCalls(options, [
    call("c", "executeCommand", {command: "echo out; echo err >&2; pwd; exit 3"}),
  ]);
  assert.deepEqual(result, {
    status: "success",
    output: {exitCode: 3, stdout: `out\n${options.workdir}\n`, stderr: "err\n"},
  });
});

void test("long output keeps its beginning and end", async () => {
  const {options} = await workspace();
  const [result] = await runCalls({...options, maxOutputBytes: 40}, [
    call("c", "executeCommand", {command: "seq 1 1000"}),
  ]);
  if (result?.status !== "success") assert.fail("the command should succeed");
  const {stdout} = result.output as {stdout: string};
  assert.match(stdout, /^1\n2\n3\n4\n5\n[\s\S]*bytes omitted[\s\S]*\n999\n1000\n$/);
});

void test("a command that outlives its timeout is stopped", async () => {
  const {options, file} = await workspace();
  const [result] = await runCalls({...options, waitSeconds: 1}, [
    call("c", "executeCommand", {command: "echo started; sleep 3; touch late", timeoutSeconds: 1}),
  ]);
  assert.deepEqual(result, {
    status: "success",
    output: {exitCode: null, stdout: "started\n", stderr: "", timedOut: true},
  });
  await delay(3500);
  assert.equal(existsSync(file("late")), false);
});

void test("interrupting the run stops a running command", async () => {
  const {options, file} = await workspace();
  let interrupt!: Channel<string>;
  const coder = agent({
    tools: sandboxTools({...options, waitSeconds: 1}),
    *model(request): Generator<unknown, ModelResponse> {
      if (request.step === 1) {
        return {
          type: "tool_calls",
          calls: [call("c", "executeCommand", {command: "touch started; sleep 3; touch late"})],
        };
      }
      return {type: "final", text: "done"};
    },
  });
  const {output: result} = await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      gen(function* () {
        interrupt = channel<string>();
        const task = r.spawn(
          coder.run("go", {
            context: {sandbox: local},
            controls: {interrupt: interrupt.receive},
          }),
        );
        yield* until(() => existsSync(file("started")));
        yield* interrupt.send("stop");
        return yield* task;
      }),
    ),
  );
  assert.equal(result.status, "interrupted");
  assert.deepEqual(results(result.messages), [{status: "cancelled", message: "stop"}]);
  await delay(3500);
  assert.equal(existsSync(file("late")), false);
});

void test("a command retried after a crash is not started twice", async () => {
  const {options, file} = await workspace();
  const coder = scripted(options, [
    call("c", "executeCommand", {command: "echo ran >> runs.log; cat runs.log"}),
  ]);
  const handler = (ctx: Context) => r.execute(ctx, coder.run("go", {context: {sandbox: local}}));
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");

  // Resume as if the process died right after starting the command, before journaling it.
  const start = live.journal.findIndex((entry) => Buffer.from(entry).includes("Start command"));
  assert.ok(start > 0);
  const resumed = await runHandler(handler, {replay: live.journal.slice(0, start)});
  assert.deepEqual(resumed.output, live.output);
  assert.equal(await readFile(file("runs.log"), "utf8"), "ran\n");
  assert.deepEqual(results(live.output.messages), [
    {status: "success", output: {exitCode: 0, stdout: "ran\n", stderr: ""}},
  ]);
});

void test("a lazy handle connects on first use, once, and again after a failure", async () => {
  let opens = 0;
  let failNext = false;
  const sandbox = lazySandbox(async () => {
    opens++;
    return {
      ...local,
      exec(script, options) {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("connection lost"));
        }
        return local.exec(script, options);
      },
    };
  });
  assert.equal(opens, 0);
  const signal = new AbortController().signal;
  await Promise.all([sandbox.exec("true", {signal}), sandbox.exec("true", {signal})]);
  assert.equal(opens, 1);
  failNext = true;
  await assert.rejects(sandbox.exec("true", {signal}), /connection lost/);
  await sandbox.exec("true", {signal});
  assert.equal(opens, 2);
});

void test("replaying a finished run never connects to the sandbox", async () => {
  const {options} = await workspace();
  let opens = 0;
  const coder = scripted(options, [
    call("w", "writeFile", {path: "a.txt", content: "a"}),
    call("c", "executeCommand", {command: "cat a.txt"}),
  ]);
  const handler = (ctx: Context) => {
    // The handler preamble: runs on every attempt, outside any journaled step.
    const sandbox = lazySandbox(async () => {
      opens++;
      return local;
    });
    return r.execute(ctx, coder.run("go", {context: {sandbox}}));
  };
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.equal(opens, 1);
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(opens, 1);
});
