// 11: A coding agent that works in a remote sandbox owned by its session.
import {createHash} from "node:crypto";
import {rpc} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, LazyStateConversation} from "@restate-agents/core";
import {sandboxTools, type SandboxContext} from "@restate-agents/core/sandbox";
import {dockerSandboxes} from "../sandboxes/docker.js";
import {modalSandboxes} from "../sandboxes/modal.js";
import {exampleModel as model, replyText} from "../shared.js";

// Modal with SANDBOX_PROVIDER=modal, otherwise a local Docker container. SANDBOX_IMAGE picks the image.
const image = process.env.SANDBOX_IMAGE;
const provider =
  process.env.SANDBOX_PROVIDER === "modal" ? modalSandboxes({image}) : dockerSandboxes({image});
const idleShutdown = {minutes: 30};

const coder = agent<SandboxContext>({
  model,
  instructions:
    "You are a coding agent working in a Linux sandbox; the project lives in /workspace. " +
    "Explore before changing code, prefer small edits with editFile, and run the code or " +
    "its tests to check your work. Finish by summarizing what you changed and how you verified it.",
  maxSteps: 50,
  tools: sandboxTools(),
});

async function isRunning(sandboxId: string) {
  try {
    await provider.connect(sandboxId).exec("true", {signal: AbortSignal.timeout(30_000)});
    return true;
  } catch {
    return false;
  }
}

/** Named after this invocation, so a retried create returns the same sandbox. */
function sandboxName() {
  const {key, id} = restate.handlerRequest();
  const invocation = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `coding-${key!.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 32)}-${invocation}`;
}

/** Reuse the session's sandbox while it runs; otherwise create one. Only its ID is stored. */
function* openSandbox(): restate.Operation<string> {
  const saved = yield* restate.state().get<string>("sandbox");
  if (saved) {
    const running = yield* restate.run(() => isRunning(saved), {name: "Check sandbox"});
    if (running) return saved;
  }
  const name = sandboxName();
  const sandboxId = yield* restate.run(() => provider.create({name}), {
    name: "Create sandbox",
    retry: {maxAttempts: 3},
  });
  restate.state().set("sandbox", sandboxId);
  return sandboxId;
}

function* closeSandbox(): restate.Operation<boolean> {
  const sandboxId = yield* restate.state().get<string>("sandbox");
  if (!sandboxId) return false;
  yield* restate.run(() => provider.terminate(sandboxId), {
    name: "Terminate sandbox",
    retry: {maxAttempts: 3},
  });
  restate.state().clear("sandbox");
  return true;
}

/** A durable timer: if no newer turn starts in the meantime, the sandbox is stopped. */
function* scheduleShutdown(turn: number): restate.Operation<void> {
  const session = restate.sendClient(codingSession, restate.handlerRequest().key!);
  yield* session.shutdownIfIdle(turn, rpc.sendOpts({delay: idleShutdown}));
}

function* signalActiveTurn(name: string, value: string): restate.Operation<boolean> {
  const active = yield* restate.sharedState().get<string>("active");
  if (!active) return false;
  restate.invocation(active).signal(name).resolve(value);
  return true;
}

export const codingSession = restate.object({
  name: "CodingSession",
  handlers: {
    turn: restate.schemas(
      {
        input: z.string().min(1).meta({
          default:
            "Create a Node.js module that returns the first n primes, add a node:test test for it, and run the test.",
        }),
        output: z.string(),
      },
      function* (message) {
        const sandboxId = yield* openSandbox();
        // Not journaled: every attempt, on whichever process runs it, gets its own handle.
        const sandbox = provider.connect(sandboxId);
        const turn = ((yield* restate.state().get<number>("turn")) ?? 0) + 1;
        restate.state().set("turn", turn);
        restate.state().set("active", restate.handlerRequest().id);
        try {
          const result = yield* coder.run(message, {
            context: {sandbox},
            conversation: new LazyStateConversation({
              compaction: {model, policy: {maxMessages: 80, retainMessages: 20}},
            }),
            steeringSignal: "steering",
            interruptSignal: "interrupt",
          });
          return replyText(result);
        } finally {
          restate.state().clear("active");
          yield* scheduleShutdown(turn);
        }
      },
    ),
    steer: restate.schemas(
      {
        input: z.string().min(1).meta({default: "Use TypeScript instead of JavaScript."}),
        output: z.boolean(),
      },
      function* (message) {
        return yield* signalActiveTurn("steering", message);
      },
    ),
    interrupt: restate.schemas(
      {
        input: z.string().min(1).meta({default: "Stop; I will take it from here."}),
        output: z.boolean(),
      },
      function* (reason) {
        return yield* signalActiveTurn("interrupt", reason);
      },
    ),
    *shutdownIfIdle(turn: number) {
      if (turn === (yield* restate.state().get<number>("turn"))) yield* closeSandbox();
    },
    *close() {
      return yield* closeSandbox();
    },
  },
  options: {
    handlers: {
      steer: {shared: true},
      interrupt: {shared: true},
    },
  },
});
