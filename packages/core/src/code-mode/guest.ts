// A deterministic QuickJS guest. Only the host scheduler may deliver tool
// completions; asynchronous tool bodies never touch this runtime.
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {positiveInteger} from "../limits.js";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
type Failure = {name: string; message: string; stack?: string};
export type Outcome = {ok: true; value: Json} | {ok: false; error: Failure};
export type Request = {id: string; name: string; args: Json[]};
type State =
  | {status: "pending"}
  | {status: "fulfilled"; value: Json}
  | {status: "rejected"; error: Failure};

// Embedded WASM also works in the endpoint's single-file esbuild deployment.
// Initialization failures fail startup, never become model observations.
const load = () => newQuickJSWASMModuleFromVariant(variant.default);
let engine = await load();
let reloading = false;

/** A runtime whose disposal aborted keeps its memory inside the WASM module.
 * Later guests move to a fresh module, so the old one can be collected. */
function replaceEngine(): void {
  if (reloading) return;
  reloading = true;
  load().then(
    (fresh) => {
      engine = fresh;
      reloading = false;
    },
    // The current module still works; a later abort tries again.
    () => (reloading = false),
  );
}

/** Only known, deterministic guest failures may become model feedback. */
export class ProgramError extends Error {}

// Program frames carry this file name; the bridge's own frames are left out.
const PROGRAM_FILE = "program.js";
const PROGRAM_PREFIX = "(async (tools) => {";

const comparable = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const reference = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;

/** Edit distance, or `limit + 1` once it is certain to exceed `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** The error for a tool name the program does not have, naming close matches. */
export function unknownTool(name: string, names: string[]): string {
  const wanted = comparable(name);
  // One edit per three characters; swapping two letters counts as two.
  const limit = Math.max(1, Math.floor(wanted.length / 3));
  const close = names.filter((candidate) => {
    const key = comparable(candidate);
    if (key === wanted) return true;
    if (Math.min(key.length, wanted.length) >= 3 && (key.includes(wanted) || wanted.includes(key)))
      return true;
    return distance(key, wanted, limit) <= limit;
  });
  let message = `${reference(name.slice(0, 100))} is not a tool.`;
  if (close.length > 0) message += ` Did you mean ${close.slice(0, 5).map(reference).join(", ")}?`;
  else if (names.length === 0) message += " This program can call no tools.";
  else if (names.length <= 20) message += ` Tools: ${names.map(reference).join(", ")}.`;
  return message;
}

/** `Name: message` and the frames inside the program, at the model's line and column. */
export function describeFailure({name, message, stack = ""}: Failure): string {
  const frames = stack
    .split("\n")
    .filter((line) => line.includes(`${PROGRAM_FILE}:`))
    // The first line starts with the wrapper's prefix.
    .map((line) =>
      line
        .trimEnd()
        .replace(
          /program\.js:1:(\d+)/,
          (_, column: string) =>
            `${PROGRAM_FILE}:1:${Math.max(1, Number(column) - PROGRAM_PREFIX.length)}`,
        ),
    );
  return [message ? `${name}: ${message}` : name, ...frames].join("\n");
}

export type GuestLimits = {
  maxInterruptChecks?: number;
  maxJobsPerDrain?: number;
  maxToolCalls?: number;
};
const MAX_SOURCE_LENGTH = 64_000;
const MAX_RESULT_LENGTH = 64_000;

/** Defaults applied and validated, so a bad limit fails when a program tool is defined. */
export function guestLimits(limits: GuestLimits = {}): Required<GuestLimits> {
  return {
    maxInterruptChecks: positiveInteger(limits.maxInterruptChecks ?? 10_000, "maxInterruptChecks"),
    maxJobsPerDrain: positiveInteger(limits.maxJobsPerDrain ?? 10_000, "maxJobsPerDrain"),
    maxToolCalls: positiveInteger(limits.maxToolCalls ?? 128, "maxToolCalls"),
  };
}

export class Guest {
  private readonly rt: QuickJSRuntime;
  private readonly vm: QuickJSContext;
  private readonly requests: Request[] = [];
  private readonly maxJobsPerDrain: number;
  private readonly bridge: QuickJSHandle[] = [];
  private readonly deliverHandle: QuickJSHandle;
  private readonly snapshotHandle: QuickJSHandle;
  private budgetExceeded = false;

  constructor(source: string, toolNames: string[], limits: GuestLimits = {}) {
    if (source.length > MAX_SOURCE_LENGTH)
      throw new ProgramError("Program source exceeds 64,000 characters");
    const {maxInterruptChecks, maxJobsPerDrain, maxToolCalls} = guestLimits(limits);
    this.maxJobsPerDrain = maxJobsPerDrain;
    this.rt = engine.newRuntime();
    this.rt.setMemoryLimit(32 * 1024 * 1024);
    this.rt.setMaxStackSize(512 * 1024);
    let interruptChecks = 0;
    this.rt.setInterruptHandler(() => {
      if (++interruptChecks > maxInterruptChecks) this.budgetExceeded = true;
      return this.budgetExceeded;
    });
    try {
      this.vm = this.rt.newContext();
    } catch (error) {
      this.rt.dispose();
      throw error;
    }
    try {
      const request = this.vm.newFunction("request", (id, name, args) => {
        this.requests.push({
          id: this.vm.getString(id),
          name: this.vm.getString(name),
          args: JSON.parse(this.vm.getString(args)),
        });
      });
      this.vm.setProp(this.vm.global, "__request", request);
      request.dispose();
      const missing = this.vm.newFunction("missing", (name) =>
        this.vm.newString(unknownTool(this.vm.getString(name), toolNames)),
      );
      this.vm.setProp(this.vm.global, "__missing", missing);
      missing.dispose();
      const setup = this.evaluate(`(() => {
        const request = globalThis.__request;
        delete globalThis.__request;
        const missing = globalThis.__missing;
        delete globalThis.__missing;
        globalThis.Date = undefined;
        Math.random = () => { throw new Error("Use a tool for randomness"); };
        Object.freeze(Math);
        const stringify = JSON.stringify, parse = JSON.parse, toString = String;
        const GuestError = Error, NativePromise = Promise;
        const resolve = Promise.resolve.bind(Promise);
        const then = Function.prototype.call.bind(Promise.prototype.then);
        const pending = new Map();
        const get = pending.get.bind(pending), set = pending.set.bind(pending), remove = pending.delete.bind(pending);
        let sequence = 0;
        let snapshot = '{"status":"pending"}';
        const tools = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
          ${JSON.stringify(toolNames)}.map(name => [name, (...args) => new NativePromise((resolve, reject) => {
            if (sequence >= ${maxToolCalls}) throw new GuestError("Program tool-call limit exceeded (${maxToolCalls} calls)");
            const id = "call-" + sequence++;
            const encoded = stringify(args);
            set(id, {resolve, reject});
            request(id, name, encoded);
          })])
        )));
        // Reading a tool that does not exist names the close matches, instead of a
        // later "not a function". Promise and JSON probes still see undefined.
        const has = Reflect.has, read = Reflect.get, ObjectPrototype = Object.prototype;
        const GuestTypeError = TypeError;
        const guarded = new Proxy(tools, {
          get(target, key, receiver) {
            if (typeof key !== "string" || has(target, key) || key === "then" || key === "toJSON" || has(ObjectPrototype, key))
              return read(target, key, receiver);
            throw new GuestTypeError(missing(key));
          }
        });
        return {
          start(program) {
            return then(then(resolve(), () => program(guarded)), value => {
              // toJSON may throw or emit tools. Serialize once, during the drain.
              const encoded = stringify(value);
              if (encoded === undefined) throw new GuestError("Program must return JSON; end it with a return statement");
              if (encoded.length > ${MAX_RESULT_LENGTH}) throw new GuestError("Program result exceeds 64,000 characters; return a smaller summary");
              snapshot = '{"status":"fulfilled","value":' + encoded + '}';
            });
          },
          deliver(id, encoded) {
            const p = get(id);
            if (!p) throw new GuestError("Unknown completion: " + id);
            remove(id);
            const outcome = parse(encoded);
            if (outcome.ok) p.resolve(outcome.value);
            else {
              const error = new GuestError(outcome.error.message);
              error.name = outcome.error.name;
              p.reject(error);
            }
          },
          snapshot() { return snapshot; },
          fail(error) {
            let name = "Error", message = "Unprintable guest error", stack = "";
            try { name = toString(error?.name ?? "Error"); } catch {}
            try { message = toString(error?.message ?? error); } catch {}
            try { stack = toString(error?.stack ?? ""); } catch {}
            snapshot = '{"status":"rejected","error":{"name":' + stringify(name) + ',"message":' + stringify(message) + ',"stack":' + stringify(stack) + '}}';
          }
        };
      })()`);
      // Keep bridge functions in host handles, outside the program's globals and
      // lexical scope. Guest code cannot forge completions or read host state.
      const start = this.vm.getProp(setup, "start");
      this.deliverHandle = this.vm.getProp(setup, "deliver");
      this.snapshotHandle = this.vm.getProp(setup, "snapshot");
      const fail = this.vm.getProp(setup, "fail");
      this.bridge.push(start, this.deliverHandle, this.snapshotHandle, fail);
      setup.dispose();
      // Install the root rejection handler before running user code. The wrapper
      // itself is compiled independently, so program source cannot close over it.
      const launch = this.evaluate(
        "(() => { const then = Function.prototype.call.bind(Promise.prototype.then); return (start, fail, program) => then(start(program), undefined, fail); })()",
      );
      this.bridge.push(launch);
      // The source is an async function body, so top-level await and return work.
      // The prefix shares its first line, keeping reported line numbers.
      const program = this.evaluate(`${PROGRAM_PREFIX}${source}\n})`, PROGRAM_FILE);
      try {
        this.checkResult(
          this.vm.callFunction(launch, this.vm.undefined, start, fail, program),
        ).dispose();
      } finally {
        program.dispose();
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private checkBudget(): void {
    if (this.budgetExceeded) throw new ProgramError("Guest execution budget exceeded");
  }

  private failGuest(error: QuickJSHandle): never {
    let detail = "Unprintable guest exception";
    try {
      const value = this.vm.dump(error);
      detail =
        typeof value?.message === "string"
          ? describeFailure({
              name: String(value.name ?? "Error"),
              message: value.message,
              stack: typeof value.stack === "string" ? value.stack : "",
            })
          : (JSON.stringify(value) ?? detail);
    } catch {
      /* Error rendering must not replace the original guest failure. */
    } finally {
      error.dispose();
    }
    this.checkBudget();
    throw new ProgramError(`Guest evaluation failed: ${detail}`);
  }

  private checkResult(result: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    if (result.error) this.failGuest(result.error);
    if (this.budgetExceeded) {
      result.value.dispose();
      this.checkBudget();
    }
    return result.value;
  }

  private evaluate(code: string, filename = "bridge.js"): QuickJSHandle {
    // Host/WASM exceptions propagate unchanged; only returned VM errors are
    // classified as deterministic program failures.
    return this.checkResult(this.vm.evalCode(code, filename));
  }

  /** Never yield to Node while draining the guest microtask queue. */
  drain(): void {
    let jobs = 0;
    while (this.rt.hasPendingJob()) {
      if (++jobs > this.maxJobsPerDrain) throw new ProgramError("Guest microtask budget exceeded");
      const result = this.rt.executePendingJobs(1);
      if (result.error) this.failGuest(result.error);
      this.checkBudget();
    }
  }

  takeRequests(): Request[] {
    return this.requests.splice(0);
  }

  deliver(id: string, outcome: Outcome): void {
    const key = this.vm.newString(id);
    const encoded = this.vm.newString(JSON.stringify(outcome));
    try {
      this.checkResult(
        this.vm.callFunction(this.deliverHandle, this.vm.undefined, key, encoded),
      ).dispose();
    } finally {
      key.dispose();
      encoded.dispose();
    }
  }

  state(): State {
    const result = this.checkResult(this.vm.callFunction(this.snapshotHandle, this.vm.undefined));
    try {
      return JSON.parse(this.vm.getString(result));
    } finally {
      result.dispose();
    }
  }

  /** Never throws: QuickJS can abort while freeing a runtime that leaked
   * objects, and that must not replace the program's outcome or skip cleanup. */
  dispose(): void {
    try {
      for (const handle of this.bridge) handle.dispose();
      this.vm.dispose();
      this.rt.dispose();
    } catch {
      replaceEngine();
    }
  }
}
