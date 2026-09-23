// Coding tools that run inside a remote sandbox the handler connects to.
import {createHash} from "node:crypto";
import {posix} from "node:path";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {ToolError} from "./errors.js";
import {tool} from "./tool.js";
import type {JsonValue, Tool, ToolContext} from "./types.js";

export type ExecResult = {exitCode: number; stdout: string; stderr: string};

/** A connection to one running sandbox. Any call may run again after a crash. */
export interface Sandbox {
  /** Run `sh -c script` and wait for it to exit. Aborting `signal` stops the wait. */
  exec(script: string, options: {signal: AbortSignal}): Promise<ExecResult>;
  /** Read a UTF-8 file, or return `undefined` when it does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /** Write a UTF-8 file, creating parent directories and replacing any existing file. */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Creates sandboxes and connects to them by ID. Journal the ID; connect in the
 * handler on every attempt, outside `run`, and pass the handle as run context.
 */
export interface SandboxProvider {
  /** Create a sandbox, or return the existing one with this name. */
  create(options: {name: string}): Promise<string>;
  /** Return a handle without any I/O; it connects on first use (see {@link lazySandbox}). */
  connect(id: string): Sandbox;
  /** Stop a sandbox. Stopping one that is already gone succeeds. */
  terminate(id: string): Promise<void>;
}

/** The application context sandbox tools use. The handle is never journaled. */
export type SandboxContext = {sandbox: Sandbox};

/**
 * A handle that opens its connection on first use and reopens it after any
 * failure. Replayed steps never touch it, so a fully journaled replay never connects.
 */
export function lazySandbox(open: () => Promise<Sandbox>): Sandbox {
  let connection: Promise<Sandbox> | undefined;
  async function use<T>(call: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const current = (connection ??= open());
    try {
      return await call(await current);
    } catch (error) {
      if (connection === current) connection = undefined;
      throw error;
    }
  }
  return {
    exec: (script, options) => use((sandbox) => sandbox.exec(script, options)),
    readFile: (path) => use((sandbox) => sandbox.readFile(path)),
    writeFile: (path, content) => use((sandbox) => sandbox.writeFile(path, content)),
  };
}

export type SandboxToolsOptions = {
  /** Relative paths resolve against this directory. Defaults to `/workspace`. */
  workdir?: string;
  /** Holds command scripts and full output. Defaults to `/tmp/restate-agents`. */
  stateDir?: string;
  /** Longest single journaled wait for a command, in seconds. Defaults to 30. */
  waitSeconds?: number;
  /** Output bytes returned to the model per stream; the rest stays on disk. Defaults to 16000. */
  maxOutputBytes?: number;
  /** Ask a person before running matching commands. */
  commandNeedsApproval?: (command: string) => boolean;
  /** Retries of each sandbox call. Defaults to three attempts. */
  retry?: restate.RetryOptions;
};

export type SandboxTools<C extends SandboxContext> = Record<
  | "readFile"
  | "writeFile"
  | "editFile"
  | "listFiles"
  | "search"
  | "executeCommand"
  | "runInBackground",
  Tool<C>
>;

/** Shell-quote one argument. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Journaled closures return failures as data: a thrown ToolError would be retried.
type Outcome<T> = {ok: true; value: T} | {ok: false; message: string; code: string};
const fail = (message: string, code: string): Outcome<never> => ({ok: false, message, code});
function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new ToolError(outcome.message, outcome.code);
  return outcome.value;
}

type CommandOutput = {exitCode: number | null; stdout: string; stderr: string; timedOut?: true};

const commandInput = z.object({
  command: z.string().min(1).describe("A shell command, run with `sh -c`."),
  cwd: z.string().optional().describe("Working directory. Defaults to the workspace."),
  timeoutSeconds: z.number().int().positive().optional(),
});

/**
 * Tools for a coding agent working in the sandbox passed as `context.sandbox`.
 * The run journals results, never the connection. Commands run at most once per
 * tool call: a retried call reattaches to the command it already started
 * instead of starting it again.
 */
export function sandboxTools<C extends SandboxContext = SandboxContext>(
  options: SandboxToolsOptions = {},
): SandboxTools<C> {
  const workdir = options.workdir ?? "/workspace";
  const stateDir = options.stateDir ?? "/tmp/restate-agents";
  const waitSeconds = options.waitSeconds ?? 30;
  const maxOutputBytes = options.maxOutputBytes ?? 16_000;
  const retry = options.retry ?? {maxAttempts: 3};
  const resolve = (path: string) => posix.resolve(workdir, path);

  /** Journal one sandbox interaction under `name`. */
  function* step<T>(
    context: ToolContext<C>,
    name: string,
    action: (sandbox: Sandbox, signal: AbortSignal) => Promise<T>,
  ): restate.Operation<T> {
    return yield* restate.run(({signal}) => action(context.context.sandbox, signal), {
      name,
      retry,
    });
  }

  function* shell(context: ToolContext<C>, name: string, script: string) {
    return yield* step(context, name, (sandbox, signal) => sandbox.exec(script, {signal}));
  }

  /** Print a file, keeping its head and tail when it exceeds the output budget. */
  const clip = (file: string) => {
    const head = Math.floor(maxOutputBytes / 4);
    const tail = maxOutputBytes - head;
    return (
      `f=${quote(file)}; [ -f "$f" ] || exit 0; size=$(wc -c < "$f"); ` +
      `if [ "$size" -le ${maxOutputBytes} ]; then cat "$f"; else ` +
      `head -c ${head} "$f"; printf '\\n[... %s bytes omitted; full output in %s ...]\\n' ` +
      `"$((size - ${maxOutputBytes}))" "$f"; tail -c ${tail} "$f"; fi`
    );
  };

  function* runCommand(
    {command, cwd, timeoutSeconds}: z.output<typeof commandInput>,
    context: ToolContext<C>,
    defaultTimeout: number,
  ): restate.Operation<JsonValue> {
    // The call's identity names its directory, so every retry finds the same command.
    const key = createHash("sha256")
      .update(`${context.invocationId}\0${context.name}\0${context.callId}`)
      .digest("hex")
      .slice(0, 32);
    const dir = `${stateDir}/${key}`;
    const d = quote(dir);
    yield* step(context, "Prepare command", (sandbox) =>
      sandbox.writeFile(
        `${dir}/command.sh`,
        `cd ${quote(resolve(cwd ?? "."))} || exit 1\n${command}\n`,
      ),
    );
    // mkdir is atomic: only the first attempt launches, later ones reattach.
    yield* shell(
      context,
      "Start command",
      `d=${d}; if mkdir "$d/launched" 2>/dev/null; then ` +
        `if command -v setsid >/dev/null 2>&1; then s=setsid; else s=; fi; ` +
        `$s sh -c 'sh "$1/command.sh" >"$1/stdout" 2>"$1/stderr" </dev/null; ` +
        `echo $? >"$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' sh "$d" >/dev/null 2>&1 & ` +
        `echo $! >"$d/pid"; fi`,
    );

    const collect = function* (exitCode: number | null) {
      const [stdout, stderr] = [
        yield* shell(context, "Read stdout", clip(`${dir}/stdout`)),
        yield* shell(context, "Read stderr", clip(`${dir}/stderr`)),
      ];
      return {exitCode, stdout: stdout.stdout, stderr: stderr.stdout};
    };
    const stop = () =>
      shell(
        context,
        "Stop command",
        // setsid made the command a process group; without it, stop the children, then the wrapper.
        `pid=$(cat ${d}/pid 2>/dev/null) && { kill -TERM "-$pid" 2>/dev/null || ` +
          `{ pkill -TERM -P "$pid"; kill -TERM "$pid"; }; } 2>/dev/null; true`,
      );

    // Wait in bounded, journaled slices: a long command survives restarts between them.
    const budget = timeoutSeconds ?? defaultTimeout;
    let finished = false;
    try {
      for (let waited = 0; waited < budget; waited += waitSeconds) {
        const ticks = Math.ceil(Math.min(waitSeconds, budget - waited) * 5);
        const {stdout: status} = yield* shell(
          context,
          "Wait for command",
          `d=${d}; [ -d "$d/launched" ] || { echo missing; exit 0; }; i=0; ` +
            `while [ ! -f "$d/exit" ] && [ "$i" -lt ${ticks} ]; do sleep 0.2; i=$((i + 1)); done; ` +
            `if [ -f "$d/exit" ]; then cat "$d/exit"; else echo running; fi`,
        );
        const state = status.trim();
        if (state === "missing")
          throw new ToolError("The sandbox lost this command; run it again.", "sandbox_reset");
        if (state !== "running") {
          finished = true;
          return (yield* collect(Number(state))) satisfies CommandOutput;
        }
      }
      yield* stop();
      finished = true;
      return {...(yield* collect(null)), timedOut: true} satisfies CommandOutput;
    } finally {
      // Cancelled mid-wait: stop the process so it does not outlive the call.
      if (!finished) yield* stop();
    }
  }

  const needsApproval = options.commandNeedsApproval;
  const commandApproval = needsApproval && {
    *needsApproval({command}: {command: string}) {
      return needsApproval(command);
    },
  };

  return {
    readFile: tool({
      description:
        "Read a text file. Lines are numbered; pass offset and limit to page through large files.",
      input: z.object({
        path: z.string().min(1),
        offset: z.number().int().positive().optional().describe("First line, starting at 1."),
        limit: z.number().int().positive().max(5000).optional().describe("Defaults to 2000."),
      }),
      describe: ({path}) => ({name: "Read file", details: {path}}),
      *execute({path, offset = 1, limit = 2000}, context) {
        const outcome = yield* step(
          context,
          "Read file",
          async (sandbox): Promise<Outcome<string>> => {
            const content = await sandbox.readFile(resolve(path));
            if (content === undefined) return fail(`${path} does not exist.`, "not_found");
            const lines = content.split("\n");
            const shown = lines.slice(offset - 1, offset - 1 + limit);
            const numbered = shown.map(
              (line, index) => `${String(offset + index).padStart(6)}\t${line}`,
            );
            const end = offset + shown.length - 1;
            if (end < lines.length) numbered.push(`[lines ${offset}-${end} of ${lines.length}]`);
            return {ok: true, value: numbered.join("\n")};
          },
        );
        return unwrap(outcome);
      },
    }),
    writeFile: tool({
      description: "Create or replace a text file. Parent directories are created as needed.",
      input: z.object({path: z.string().min(1), content: z.string()}),
      describe: ({path}) => ({name: "Write file", details: {path}}),
      *execute({path, content}, context) {
        yield* step(context, "Write file", (sandbox) => sandbox.writeFile(resolve(path), content));
        return {path, bytes: Buffer.byteLength(content)};
      },
    }),
    editFile: tool({
      description:
        "Replace exact text in a file. oldText must match once, including whitespace, " +
        "unless replaceAll is set. Prefer this to rewriting whole files.",
      input: z.object({
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().optional(),
      }),
      describe: ({path}) => ({name: "Edit file", details: {path}}),
      *execute({path, oldText, newText, replaceAll}, context) {
        // Journal the edited content, then write it: a retried write repeats the same bytes.
        const outcome = yield* step(
          context,
          "Edit file",
          async (sandbox): Promise<Outcome<{content: string; replacements: number}>> => {
            const content = await sandbox.readFile(resolve(path));
            if (content === undefined) return fail(`${path} does not exist.`, "not_found");
            const replacements = content.split(oldText).length - 1;
            if (replacements === 0) return fail(`oldText was not found in ${path}.`, "no_match");
            if (replacements > 1 && !replaceAll)
              return fail(
                `oldText matches ${replacements} times in ${path}; add surrounding lines or set replaceAll.`,
                "ambiguous_match",
              );
            return {ok: true, value: {content: content.replaceAll(oldText, newText), replacements}};
          },
        );
        const {content, replacements} = unwrap(outcome);
        yield* step(context, "Write file", (sandbox) => sandbox.writeFile(resolve(path), content));
        return {path, replacements};
      },
    }),
    listFiles: tool({
      description: "List files under a directory, skipping .git and node_modules.",
      input: z.object({
        path: z.string().optional().describe("Defaults to the workspace."),
        maxDepth: z.number().int().positive().max(10).optional().describe("Defaults to 3."),
      }),
      describe: ({path}) => ({name: "List files", details: {path: path ?? "."}}),
      *execute({path = ".", maxDepth = 3}, context) {
        const {exitCode, stdout, stderr} = yield* shell(
          context,
          "List files",
          `cd ${quote(resolve(path))} && find . -maxdepth ${maxDepth} ` +
            `\\( -name .git -o -name node_modules \\) -prune -o -type f -print | sed 's|^\\./||' | sort | head -n 1000`,
        );
        if (exitCode !== 0)
          throw new ToolError(stderr.trim() || `Cannot list ${path}.`, "not_found");
        return stdout || "No files.";
      },
    }),
    search: tool({
      description:
        "Search file contents with an extended regular expression. Returns up to 200 matching lines as path:line:text.",
      input: z.object({
        pattern: z.string().min(1),
        path: z.string().optional().describe("File or directory. Defaults to the workspace."),
      }),
      describe: ({pattern}) => ({name: "Search", details: {pattern}}),
      *execute({pattern, path = "."}, context) {
        // find and grep -nHE work the same with GNU, BSD, and BusyBox tools.
        const {stdout, stderr} = yield* shell(
          context,
          "Search",
          `find ${quote(resolve(path))} \\( -name .git -o -name node_modules \\) -prune -o -type f ` +
            `-exec grep -nHE -e ${quote(pattern)} {} + | head -n 200`,
        );
        if (stdout) return stdout;
        if (stderr.trim()) throw new ToolError(stderr.trim(), "search_failed");
        return "No matches.";
      },
    }),
    executeCommand: tool({
      description:
        "Run a shell command and wait for it. Returns the exit code with stdout and stderr; " +
        "long output keeps its beginning and end. Defaults to a 10 minute timeout.",
      input: commandInput,
      describe: ({command}) => ({name: "Run command", details: {command}}),
      ...commandApproval,
      *execute(input, context) {
        return yield* runCommand(input, context, 600);
      },
    }),
    runInBackground: tool({
      description:
        "Start a long-running command, such as a build or test suite, and keep working. " +
        "Its result arrives when it exits. Defaults to a one hour timeout.",
      input: commandInput,
      background: true,
      describe: ({command}) => ({name: "Run in background", details: {command}}),
      ...commandApproval,
      *execute(input, context) {
        return yield* runCommand(input, context, 3600);
      },
    }),
  };
}
