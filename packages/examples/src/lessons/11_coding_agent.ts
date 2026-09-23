// 11: A coding agent whose tools work in a Modal sandbox for the length of one request.
import * as restate from "@restatedev/restate-sdk-gen";
import {ModalClient, Sandbox, SandboxFilesystemNotFoundError} from "modal";
import {z} from "zod";
import {agent, asyncTool, ToolError} from "@restate-agents/core";
import {exampleModel as model, replyText} from "../shared.js";

// Created on first use, so the other lessons run without Modal credentials.
let client: ModalClient | undefined;
const modal = () => (client ??= new ModalClient());

/** Create the sandbox once; replays get the journaled ID back instead of a new sandbox. */
function* connect(): restate.Operation<Sandbox> {
  const id = yield* restate.run(
    async () => {
      const app = await modal().apps.fromName("restate-agents", {createIfMissing: true});
      const sandbox = await modal().sandboxes.create(app, modal().images.fromRegistry("node:24"), {
        workdir: "/workspace",
        // Modal stops a forgotten sandbox, e.g. one created just before a crash.
        timeoutMs: 60 * 60 * 1000,
        idleTimeoutMs: 10 * 60 * 1000,
      });
      return sandbox.sandboxId;
    },
    {name: "Create sandbox"},
  );
  // What sandboxes.fromId does, without its promise: a handle for the ID, no I/O.
  // It is rebuilt on every attempt, in whichever process runs the request.
  return new Sandbox(modal(), id);
}

function* release(sandbox: Sandbox): restate.Operation<void> {
  yield* restate.run(() => sandbox.terminate(), {name: "Release sandbox"});
}

type CodingContext = {sandbox: Sandbox};

const coder = agent<CodingContext>({
  model,
  instructions:
    "You are a coding agent in a Linux sandbox; work in /workspace. Write the code, run it " +
    "to check it, and finish with a short summary of what you did.",
  maxSteps: 30,
  tools: {
    readFile: asyncTool({
      description: "Read a text file.",
      input: z.object({path: z.string()}),
      async execute({path}, {context}) {
        try {
          return await context.sandbox.filesystem.readText(path);
        } catch (error) {
          if (error instanceof SandboxFilesystemNotFoundError)
            throw new ToolError(`${path} does not exist.`, "not_found");
          throw error;
        }
      },
    }),
    writeFile: asyncTool({
      description: "Create or replace a text file.",
      input: z.object({path: z.string(), content: z.string()}),
      async execute({path, content}, {context}) {
        await context.sandbox.filesystem.writeText(content, path);
        return {path};
      },
    }),
    runCommand: asyncTool({
      description: "Run a shell command in /workspace. Returns its exit code and output.",
      input: z.object({command: z.string()}),
      // One attempt: a failure goes to the model instead of running the command again.
      retry: {maxAttempts: 1},
      async execute({command}, {context}) {
        const process = await context.sandbox.exec(["sh", "-c", command], {
          workdir: "/workspace",
          timeoutMs: 5 * 60 * 1000,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
          process.wait(),
        ]);
        // Keep the end of long output, where errors usually are.
        return {exitCode, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000)};
      },
    }),
  },
});

export const codingAgent = restate.service({
  name: "CodingAgent",
  handlers: {
    ask: restate.schemas(
      {
        input: z
          .string()
          .min(1)
          .meta({default: "Write primes.js that prints the first 10 primes, then run it."}),
        output: z.string(),
      },
      function* (task) {
        const sandbox = yield* connect();
        try {
          const result = yield* coder.run(task, {context: {sandbox}});
          return replyText(result);
        } finally {
          yield* release(sandbox);
        }
      },
    ),
  },
});
