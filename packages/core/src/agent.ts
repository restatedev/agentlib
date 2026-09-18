import {z} from "zod";
import {CancelledError} from "@restatedev/restate-sdk";
import {
  allSettled,
  channel,
  handlerRequest,
  run as journal,
  InterruptedError,
  select,
  signal,
  spawn,
  type Future,
  type Operation,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {
  AgentLimitError,
  denial,
  GuardrailError,
  ModelProtocolError,
  RunInterrupted,
  ToolCancelled,
  ToolDenied,
  ToolError,
} from "./errors.js";
import type {
  Agent,
  AgentEvent,
  AgentOptions,
  AgentRuntime,
  Message,
  OutputCandidate,
  RunContext,
  RunOptions,
  RunResult,
  ToolCall,
  ToolContext,
  ToolInfo,
  ToolResult,
} from "./types.js";
import {createToolCatalog, type ToolCatalog} from "./tool-catalog.js";
import {streamRun} from "./agent-stream.js";
import {history, jsonSchema, modelResponse} from "./validation.js";
import {positiveInteger as limit} from "./limits.js";

type Entry = {call: ToolCall; background: boolean; task: Task<ToolResult>; result?: ToolResult};

/** Embeddable task loop. Definitions are reusable; every mutable object is run-local. */
export function agent<C = undefined, O = string>(options: AgentOptions<C, O>): Agent<C, O> {
  const maxSteps = limit(options.maxSteps ?? 10, "maxSteps");
  const maxToolCalls = limit(options.maxToolCalls ?? 128, "maxToolCalls");
  const maxToolDepth = limit(options.maxToolDepth ?? 16, "maxToolDepth");
  const maxOutputTokens = limit(options.maxOutputTokens ?? 4096, "maxOutputTokens");
  // Output policies receive parsed values and validation runs again afterward.
  // Requiring a representable output schema rejects transforms that would run twice.
  const outputSchema = options.output ? z.toJSONSchema(options.output) : undefined;
  const maxOutputChars = limit(options.maxOutputChars ?? 128000, "maxOutputChars");

  function* run(input: string, runOptions?: RunOptions<C>): Operation<RunResult<O>> {
    if (typeof input !== "string" || !input.trim())
      throw new TypeError("Agent input must be a nonempty string");
    const conversation = runOptions?.conversation;
    if (conversation && runOptions?.messages)
      throw new TypeError("Use either conversation or messages");
    const snapshot = conversation ? yield* conversation.load() : undefined;
    let conversationVersion = snapshot?.version ?? 0;
    const messages = history(snapshot?.messages ?? runOptions?.messages ?? []);
    let persisted = messages.length;
    function* save(): Operation<void> {
      if (conversation && messages.length > persisted) {
        conversationVersion = yield* conversation.append(
          messages.slice(persisted),
          conversationVersion,
        );
        persisted = messages.length;
      }
    }
    messages.push({role: "user", content: input});
    let active: AgentRuntime<C> = options;
    let current = createToolCatalog(active.tools, runOptions?.tools);
    const context: RunContext<C> = {
      context: runOptions?.context as C,
      invocationId: handlerRequest().id,
      name: runOptions?.name ?? options.name ?? "agent",
    };
    const usedIds = new Set(
      messages.flatMap((m) => (m.role === "assistant" ? (m.calls ?? []).map((c) => c.id) : [])),
    );
    const owned = new Set<Task<unknown>>();
    const pending = new Map<string, Entry>();
    const observations: Message[] = [];
    const steering: string[] = [];
    let steeringReady = channel<void>();
    const fatal = channel<void>();
    let failure: {error: unknown} | undefined;
    let sequence = 0,
      step = 0,
      calls = 0,
      revision = 0;
    let batch: Entry[] | undefined;
    let watcher: Task<void> | undefined;
    let stopping = false;

    function track<T>(operation: Operation<T>): Task<T> {
      const task = spawn(
        (function* () {
          try {
            return yield* operation;
          } catch (error) {
            // A later child failure must wake the parent even while a different
            // tool, approval, model, or event hook is parked.
            if (!(error instanceof InterruptedError)) {
              failure ??= {error};
              yield* fatal.send();
            }
            throw error;
          }
        })(),
      );
      owned.add(task);
      return task;
    }
    function* update(event: AgentEvent): Operation<void> {
      const number = ++sequence;
      const value = {
        ...event,
        sequence: number,
        id: `${context.invocationId}:${context.name}:${number}`,
      };
      if (options.onUpdate) yield* options.onUpdate(structuredClone(value), context.context);
      if (runOptions?.onUpdate) yield* runOptions.onUpdate(structuredClone(value), context.context);
    }
    function observe(value: Record<string, unknown>) {
      observations.push({
        role: "user",
        content: JSON.stringify({source: "agent-runtime", ...value}),
      });
      revision++;
    }
    function* drainSteering(): Operation<void> {
      const updates = steering.splice(0);
      steeringReady = channel<void>();
      for (const message of updates) {
        observe({type: "steering", message});
        yield* update({type: "steering", step, message});
      }
    }
    function collect() {
      for (const [id, entry] of pending) {
        if (!entry.result) continue;
        pending.delete(id);
        observe({
          type: "background-tool-result",
          operationId: id,
          name: entry.call.name,
          result: entry.result,
        });
      }
    }
    function flush() {
      messages.push(...observations.splice(0));
    }
    function* ready(
      branches: Record<string, Future<unknown>>,
    ): Operation<{tag: string; value: unknown}> {
      while (true) {
        const branchesToSelect: Record<string, Future<unknown>> = {
          ...(watcher ? {steering: steeringReady.receive} : {}),
          ...Object.fromEntries([...pending].map(([id, e]) => [`pending:${id}`, e.task])),
          ...branches,
        };
        const selected = yield* select(branchesToSelect);
        const value = yield* selected.future;
        if (selected.tag === "steering") {
          yield* drainSteering();
          if (!Object.keys(branches).length) return {tag: "steering", value};
        } else if (selected.tag.startsWith("pending:")) {
          collect();
          if (!Object.keys(branches).length) return {tag: selected.tag, value};
        } else return {tag: selected.tag, value};
      }
    }
    function* executeCall(
      call: ToolCall,
      callStep: number,
      owner: AgentRuntime<C>,
      registry: ToolCatalog<C>,
      depth = 0,
    ): Operation<ToolResult> {
      if (++calls > maxToolCalls) throw new AgentLimitError("Maximum tool calls exceeded");
      if (depth > maxToolDepth) throw new AgentLimitError("Maximum nested tool depth exceeded");
      const definition = registry.registry.get(call.name);
      if (!definition)
        return {status: "error", code: "unknown_tool", message: `Unknown tool: ${call.name}`};
      let nested = 0,
        approval = 0;
      let info: ToolInfo = {name: call.name, details: structuredClone(call.input)};
      const toolContext: ToolContext<C> = {
        ...context,
        callId: call.id,
        toolName: call.name,
        get info() {
          return structuredClone(info);
        },
        *describe(next) {
          if (!next || typeof next.name !== "string" || !next.name.trim())
            throw new TypeError("Tool display name must be a nonempty string");
          const snapshot: ToolInfo = {
            name: next.name,
            ...(next.details === undefined ? {} : {details: jsonSchema.parse(next.details)}),
          };
          if (JSON.stringify(snapshot).length > maxOutputChars)
            throw new AgentLimitError("Tool display information exceeds maxOutputChars");
          info = snapshot;
          yield* update({type: "tool-info", step: callStep, callId: call.id, info});
        },
        step: callStep,
        availableTools: () => [...registry.registry.keys()],
        *searchTools(query) {
          const selected = yield* journal(async () => registry.search.search(query), {
            name: `tool-search:${call.id}`,
            retry: {maxAttempts: 1},
          });
          return registry.search.load(selected);
        },
        *progress(value) {
          yield* update({
            type: "progress",
            step: callStep,
            callId: call.id,
            value: jsonSchema.parse(value),
          });
        },
        *approve(input, question) {
          const request = {
            call: {...call, input},
            signalName: `${context.name}:approval:${call.id}:${approval++}`,
            ...(question === undefined ? {} : {question}),
          };
          yield* update({type: "approval-required", step: callStep, request});
          if (owner.onHumanApproval)
            return (yield* owner.onHumanApproval(request, toolContext)) === true;
          if (options.onHumanApproval)
            return (yield* options.onHumanApproval(request, toolContext)) === true;
          return (yield* signal<boolean>(request.signalName)) === true;
        },
        *callTool(name, input) {
          if (registry.registry.get(name)?.handoff)
            throw new ToolError("Handoffs must be direct model calls");
          const child = {id: `${call.id}/nested-${nested++}`, name, input: jsonSchema.parse(input)};
          yield* update({
            type: "tool-start",
            step: callStep,
            call: child,
            info: {name, details: child.input},
          });
          const result = yield* executeCall(child, callStep, owner, registry, depth + 1);
          yield* update({type: "tool-end", step: callStep, call: child, result});
          if (result.status === "success") return result.output;
          if (result.status === "cancelled") throw new ToolCancelled(result.message);
          throw new ToolError(
            "message" in result ? result.message : "Unexpected pending nested call",
            result.status === "error" ? result.code : result.status,
          );
        },
        *cancelOperation(id, reason = "Cancelled by the agent") {
          const entry = pending.get(id);
          if (!entry) throw new ToolError(`Unknown pending operation: ${id}`, "unknown_operation");
          if (entry.result) return false;
          entry.task.interrupt(new ToolCancelled(reason));
          const result = yield* entry.task;
          return result.status === "cancelled";
        },
      };
      try {
        const reason = options.beforeTool
          ? denial(yield* options.beforeTool(structuredClone(call), toolContext))
          : undefined;
        if (reason !== undefined) throw new ToolDenied(reason);
        if (owner !== options && owner.beforeTool) {
          const denied = denial(yield* owner.beforeTool(structuredClone(call), toolContext));
          if (denied !== undefined) throw new ToolDenied(denied);
        }
        let output = yield* definition.execute(call.input, toolContext);
        if (owner !== options && owner.afterTool)
          output = yield* owner.afterTool(output, toolContext);
        if (options.afterTool) output = yield* options.afterTool(output, toolContext);
        output = jsonSchema.parse(output);
        if (JSON.stringify(output).length > maxOutputChars)
          throw new ToolError("Tool output exceeds maxOutputChars", "output_limit");
        return {status: "success", output};
      } catch (error) {
        if (error instanceof RunInterrupted || error instanceof ToolCancelled)
          return {status: "cancelled", message: error.message};
        if (error instanceof ToolDenied) return {status: "denied", message: error.message};
        if (error instanceof ToolError)
          return {status: "error", code: error.code, message: error.message};
        throw error;
      }
    }
    function start(call: ToolCall): Entry {
      const callStep = step;
      const owner = active;
      const registry = current;
      function* invokeTool(): Operation<ToolResult> {
        yield* update({
          type: "tool-start",
          step: callStep,
          call,
          info: {name: call.name, details: call.input},
        });
        const result = yield* executeCall(call, callStep, owner, registry);
        yield* update({type: "tool-end", step: callStep, call, result});
        entry.result = result;
        return result;
      }
      const entry: Entry = {
        call,
        background: registry.registry.get(call.name)?.background ?? false,
        task: track(invokeTool()),
      };
      return entry;
    }
    function commitBatch(reason?: string) {
      if (!batch) return;
      messages.push(
        ...batch.map((entry): Message => ({
          role: "tool",
          callId: entry.call.id,
          name: entry.call.name,
          result: entry.background
            ? {status: "pending", operationId: entry.call.id}
            : (entry.result ?? {status: "cancelled", message: reason ?? "Run stopped"}),
        })),
      );
      batch = undefined;
    }
    function* stopWork(reason: InterruptedError): Operation<void> {
      for (const task of owned) task.interrupt(reason);
      const results = yield* allSettled([...owned]);
      const failed = results.find(
        (r) => r.status === "rejected" && !(r.reason instanceof InterruptedError),
      );
      if (failed?.status === "rejected") throw failed.reason;
      commitBatch(reason.message);
      // Even work interrupted before its first execute yield gets an observation.
      for (const entry of pending.values())
        entry.result ??= {status: "cancelled", message: reason.message};
      collect();
      yield* drainSteering();
      flush();
    }
    function* finish(result: RunResult<O>): Operation<RunResult<O> | undefined> {
      if (result.status !== "completed" && options.finalize) {
        const request = {
          messages: [
            ...messages,
            {
              role: "user" as const,
              content: `The run stopped: ${result.reason}. Summarize completed results and unresolved work. Do not claim cancelled work succeeded. No tools are available.`,
            },
          ],
          tools: [],
        };
        let text: string;
        try {
          const final = modelResponse(yield* options.finalize(request));
          if (final.type !== "final")
            throw new ModelProtocolError("Finalization must not request tools");
          text = final.text;
        } catch (error) {
          if (error instanceof InterruptedError || error instanceof CancelledError) throw error;
          text = `The run stopped (${result.reason}); a final summary could not be generated.`;
        }
        result = {...result, output: text};
      }
      const beforeGuard = revision;
      if (options.afterRun) {
        // Policies see the candidate, but it is not part of committed history.
        const candidate = structuredClone(result);
        if (candidate.output !== undefined)
          candidate.messages.push({
            role: "assistant",
            content:
              typeof candidate.output === "string"
                ? candidate.output
                : JSON.stringify(candidate.output),
          });
        // The clone gives untyped policies isolation; the public view is deeply readonly.
        const guarded = track(
          options.afterRun(candidate as unknown as OutputCandidate<O>, context),
        );
        yield* ready({guard: guarded});
        const decision = yield* guarded;
        if (decision !== undefined) {
          if (
            decision === null ||
            typeof decision !== "object" ||
            !Object.hasOwn(decision, "output") ||
            Reflect.ownKeys(decision).some((key) => key !== "output")
          )
            throw new GuardrailError(
              "afterRun must return nothing or an object containing only output",
            );
          if (result.status === "completed") {
            // The root output schema (or text contract) validates this below.
            result = {...result, output: decision.output as O};
          } else {
            const summary: unknown = decision.output;
            if (summary !== undefined && typeof summary !== "string")
              throw new GuardrailError("A stopped or interrupted output must be a text summary");
            result = {...result, output: summary};
          }
        }
      }
      if (result.status === "completed" && (steering.length || revision !== beforeGuard)) {
        // Steering may arrive while a generator output policy is awaiting I/O.
        // The candidate has not been published; replan against the new input.
        yield* drainSteering();
        flush();
        return undefined;
      }
      watcher?.interrupt(new InterruptedError("Run is finalizing"));
      if (watcher) yield* allSettled([watcher]);
      if (result.status === "completed") {
        if (options.output) result = {...result, output: options.output.parse(result.output)};
        else if (typeof result.output !== "string")
          throw new GuardrailError("A completed text run must have a string output");
      }
      const output = result.output === undefined ? undefined : jsonSchema.parse(result.output);
      if (output !== undefined && JSON.stringify(output).length > maxOutputChars)
        throw new AgentLimitError("Final output exceeds maxOutputChars");
      // From this point the answer is accepted. A late application interrupt
      // must not turn publication/cleanup into a second finalization attempt.
      stopping = true;
      // Commit only the accepted output. An interrupted policy cannot leak its
      // candidate, and policy-provided stopped summaries get their own message.
      if (output !== undefined) {
        messages.push({
          role: "assistant",
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }
      result = {...result, messages: structuredClone(messages)};
      yield* save();
      yield* update({
        type: "run-end",
        step,
        status: result.status,
        ...(output === undefined ? {} : {output}),
      });
      return result;
    }
    function* drive(): Operation<RunResult<O>> {
      try {
        const rejected = options.beforeRun
          ? denial(yield* options.beforeRun(structuredClone(messages), context))
          : undefined;
        if (rejected !== undefined) throw new GuardrailError(rejected);
        if (conversation?.compact) {
          yield* conversation.compact();
          const compacted = yield* conversation.load();
          messages.splice(0, messages.length, ...history(compacted.messages), {
            role: "user",
            content: input,
          });
          persisted = compacted.messages.length;
          conversationVersion = compacted.version;
        }
        for (step = 1; step <= maxSteps; step++) {
          yield* drainSteering();
          collect();
          flush();
          yield* save();
          const instructions =
            typeof active.instructions === "function"
              ? yield* active.instructions(context)
              : active.instructions;
          const request = {
            instructions,
            outputSchema,
            maxOutputTokens,
            step,
            messages: structuredClone(messages),
            tools: current.visibleManifests(),
          };
          const blocked = options.beforeStep
            ? denial(yield* options.beforeStep(request, context))
            : undefined;
          if (blocked !== undefined) throw new GuardrailError(blocked);
          if (active !== options && active.beforeStep) {
            const blocked = denial(yield* active.beforeStep(request, context));
            if (blocked !== undefined) throw new GuardrailError(blocked);
          }
          yield* update({type: "step-start", step});
          const atRequest = revision;
          const modelTask = track(active.model(request));
          const action = modelResponse((yield* ready({model: modelTask})).value);
          yield* drainSteering();
          collect();
          if ((action.chunks ?? []).reduce((n, c) => n + c.text.length, 0) > maxOutputChars)
            throw new AgentLimitError("Model chunks exceed maxOutputChars");
          for (const chunk of action.chunks ?? [])
            yield* update({type: "model-chunk", step, chunk});
          if ((action.text?.length ?? 0) > maxOutputChars)
            throw new AgentLimitError("Model output exceeds maxOutputChars");
          // A new steering message or background outcome invalidates the whole
          // plan, including calls that would cause side effects. Already-started
          // tool batches are allowed to settle and retain their results.
          yield* drainSteering();
          collect();
          if (revision !== atRequest) continue;
          if (action.type === "final") {
            flush();
            if (pending.size) {
              if (step < maxSteps) yield* ready({});
              continue;
            }
            let output: O;
            if (options.output) {
              let candidate: unknown = action.output;
              if (candidate === undefined) {
                try {
                  candidate = JSON.parse(action.text);
                } catch {}
              }
              const parsed = options.output.safeParse(candidate);
              if (action.validationError || !parsed.success) {
                yield* update({
                  type: "output-invalid",
                  step,
                  reason: action.validationError ?? "Output schema validation failed",
                });
                messages.push({role: "assistant", content: action.text});
                observe({
                  type: "output-invalid",
                  instruction: "Return a final answer matching the requested output schema.",
                });
                continue;
              }
              output = parsed.data;
            } else {
              if (action.validationError) throw new ModelProtocolError(action.validationError);
              output = action.text as O;
            }
            const finished = yield* finish({status: "completed", output, steps: step, messages});
            if (finished) return finished;
            continue;
          }
          const transfers = action.calls.filter((call) => current.registry.get(call.name)?.handoff);
          if (transfers.length > 1)
            throw new ModelProtocolError("Only one handoff is allowed per batch");
          if (calls + action.calls.length > maxToolCalls)
            throw new AgentLimitError("Maximum tool calls exceeded");
          for (const call of action.calls) {
            if (usedIds.has(call.id))
              throw new ModelProtocolError(`Duplicate tool-call ID: ${call.id}`);
            usedIds.add(call.id);
          }
          messages.push({
            role: "assistant",
            content: action.text ?? "",
            calls: structuredClone(action.calls),
          });
          batch = action.calls.map(start);
          const foreground = new Map<string, Future<unknown>>();
          for (const entry of batch) {
            if (entry.background) pending.set(entry.call.id, entry);
            else foreground.set(`tool:${entry.call.id}`, entry.task);
          }
          for (const entry of batch)
            if (pending.has(entry.call.id))
              yield* update({
                type: "tool-pending",
                step,
                call: entry.call,
                operationId: entry.call.id,
              });
          while (foreground.size) {
            const next = yield* ready(Object.fromEntries(foreground));
            foreground.delete(next.tag);
          }
          const transfer = transfers[0];
          const transferred =
            transfer && batch.find((e) => e.call.id === transfer.id)?.result?.status === "success";
          commitBatch();
          collect();
          flush();
          if (transferred) {
            const from = active.name ?? "agent";
            active = current.registry.get(transfer.name)!.handoff!();
            current = createToolCatalog(active.tools);
            yield* update({type: "handoff", step, from, to: active.name ?? "agent"});
          }
        }
        step = maxSteps;
        stopping = true;
        yield* stopWork(new RunInterrupted("Maximum model steps reached"));
        return (yield* finish({status: "stopped", reason: "max_steps", steps: step, messages}))!;
      } catch (error) {
        if (!(error instanceof RunInterrupted)) throw error;
        stopping = true;
        yield* stopWork(error);
        return (yield* finish({
          status: "interrupted",
          reason: error.message,
          steps: step,
          messages,
        }))!;
      } finally {
        for (const task of owned) task.interrupt(new InterruptedError("Agent run finished"));
        yield* allSettled([...owned]);
      }
    }

    const controls = runOptions?.controls;
    const steeringSource = controls?.steering
      ? () => controls.steering!()
      : runOptions?.steeringSignal
        ? () => signal<string>(runOptions.steeringSignal!)
        : undefined;
    if (steeringSource)
      watcher = track(
        (function* () {
          while (true) {
            const message = yield* steeringSource();
            if (typeof message !== "string" || !message.trim())
              throw new TypeError("Steering must be a nonempty string");
            steering.push(message);
            yield* steeringReady.send();
          }
        })(),
      );
    const interrupt =
      runOptions?.controls?.interrupt ??
      (runOptions?.interruptSignal ? signal<string>(runOptions.interruptSignal) : undefined);
    const driver = spawn(drive());
    try {
      const rootBranches: Record<string, Future<unknown>> = {
        fatal: fatal.receive,
        ...(interrupt ? {interrupt} : {}),
        driver,
      };
      const selected = yield* select(rootBranches);
      if (selected.tag === "fatal") {
        driver.interrupt(failure!.error);
        yield* allSettled([driver]);
        throw failure!.error;
      }
      if (selected.tag === "interrupt") {
        const reason = yield* selected.future;
        if (typeof reason !== "string") throw new TypeError("Interruption reason must be a string");
        if (!stopping) driver.interrupt(new RunInterrupted(reason));
      }
      return yield* driver;
    } catch (error) {
      driver.interrupt(error);
      yield* allSettled([driver]);
      throw error;
    } finally {
      watcher?.interrupt();
      if (watcher) yield* allSettled([watcher]);
    }
  }

  return {
    definition: options,
    run,
    *stream(
      input: string,
      runOptions?: RunOptions<C>,
    ): Operation<import("./types.js").AgentStream<O>> {
      return yield* streamRun((emit) =>
        run(input, {
          ...runOptions,
          *onUpdate(event, context) {
            if (runOptions?.onUpdate) yield* runOptions.onUpdate(structuredClone(event), context);
            yield* emit(event);
          },
        } as RunOptions<C>),
      );
    },
  };
}
