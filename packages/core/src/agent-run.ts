import {
  handlerRequest,
  InterruptedError,
  select,
  signal,
  type Operation,
} from "@restatedev/restate-sdk-gen";
import {
  AgentLimitError,
  denial,
  GuardrailError,
  ModelProtocolError,
  RunInterrupted,
} from "./errors.js";
import {RunHistory} from "./run-history.js";
import {RunTasks, type FutureBranches} from "./run-tasks.js";
import {RunTools} from "./run-tools.js";
import {RunUpdates} from "./run-updates.js";
import {createToolCatalog, type ToolCatalog} from "./tool-catalog.js";
import type {ToolExecutionLimits} from "./tool-executor.js";
import {applyOutputDecision, createOutputCandidate, summarizeStoppedRun} from "./run-output.js";
import {jsonSchema, modelResponse} from "./validation.js";
import type {
  AgentOptions,
  AgentRuntime,
  ModelFinalResponse,
  ModelResponse,
  ModelToolCallsResponse,
  RunContext,
  RunOptions,
  RunResult,
  SteeringSource,
} from "./types.js";

export type RunConfiguration = ToolExecutionLimits &
  Readonly<{
    maxSteps: number;
    maxOutputTokens: number;
    outputSchema?: Record<string, unknown>;
  }>;

type SelectionResult = {tag: string; value: unknown};

export function* runAgent<C, O>(
  input: string,
  root: AgentOptions<C, O>,
  config: RunConfiguration,
  options?: RunOptions<C>,
): Operation<RunResult<O>> {
  const history = yield* RunHistory.load(input, options);
  return yield* new AgentRun(root, config, history, options).run();
}

/** Orchestrates one run. Only the planning step and active agent/catalog change
 * here; collaborators own task lifetime, tool batches, updates, and history. */
class AgentRun<C, O> {
  private step = 0;
  private active: AgentRuntime<C>;
  private catalog: ToolCatalog<C>;
  private readonly context: RunContext<C>;
  private readonly tasks: RunTasks;
  private readonly tools: RunTools<C>;
  private readonly updates: RunUpdates<C>;

  constructor(
    private readonly root: AgentOptions<C, O>,
    private readonly config: RunConfiguration,
    private readonly history: RunHistory,
    private readonly options?: RunOptions<C>,
  ) {
    this.active = root;
    this.catalog = createToolCatalog(root.tools, options?.tools);
    this.context = {
      context: options?.context as C,
      invocationId: handlerRequest().id,
      name: options?.name ?? root.name ?? "agent",
    };
    this.tasks = new RunTasks();
    this.updates = new RunUpdates(
      this.context,
      history,
      root.onUpdate?.bind(root),
      options?.onUpdate?.bind(options),
    );
    this.tools = new RunTools(
      root,
      this.context,
      config,
      this.tasks,
      history,
      this.updates,
      options?.onApproval?.bind(options),
    );
  }

  *run(): Operation<RunResult<O>> {
    const controls = this.options?.controls;
    const steeringSignal = this.options?.steeringSignal;
    let steering: SteeringSource | undefined;
    if (controls?.steering) {
      steering = () => controls.steering!();
    } else if (steeringSignal) {
      steering = () => signal<string>(steeringSignal);
    }
    this.updates.startSteering(this.tasks, steering);
    let interrupt = controls?.interrupt;
    if (!interrupt && this.options?.interruptSignal) {
      interrupt = signal<string>(this.options.interruptSignal);
    }
    try {
      return yield* this.tasks.supervise(this.drive(), interrupt);
    } finally {
      yield* this.updates.stopSteering();
    }
  }

  private *drive(): Operation<RunResult<O>> {
    try {
      if (this.root.beforeRun) {
        const rejected = denial(yield* this.root.beforeRun(this.history.snapshot(), this.context));
        if (rejected !== undefined) throw new GuardrailError(rejected);
      }
      yield* this.history.compact();
      for (this.step = 1; this.step <= this.config.maxSteps; this.step++) {
        const action = yield* this.plan();
        if (!action) continue;
        if (action.type === "final") {
          const result = yield* this.complete(action);
          if (result) return result;
        } else {
          yield* this.executeTools(action);
        }
      }
      this.step = this.config.maxSteps;
      this.tasks.beginFinalization();
      yield* this.stop(new RunInterrupted("Maximum model steps reached"));
      return (yield* this.finish({
        status: "stopped",
        reason: "max_steps",
        steps: this.step,
        messages: this.history.snapshot(),
      }))!;
    } catch (error) {
      if (!(error instanceof RunInterrupted)) throw error;
      this.tasks.beginFinalization();
      yield* this.stop(error);
      return (yield* this.finish({
        status: "interrupted",
        reason: error.message,
        steps: this.step,
        messages: this.history.snapshot(),
      }))!;
    } finally {
      yield* this.tasks.close();
    }
  }

  private *plan(): Operation<ModelResponse | undefined> {
    yield* this.updates.drainSteering(this.step);
    this.tools.collectResults();
    this.history.flush();
    yield* this.history.save();
    let instructions: string | undefined;
    if (typeof this.active.instructions === "function") {
      instructions = yield* this.active.instructions(this.context);
    } else {
      instructions = this.active.instructions;
    }
    const request = {
      instructions,
      outputSchema: this.config.outputSchema,
      maxOutputTokens: this.config.maxOutputTokens,
      step: this.step,
      messages: this.history.snapshot(),
      tools: this.catalog.visibleManifests(),
    };
    if (this.root.beforeStep) {
      const blocked = denial(yield* this.root.beforeStep(request, this.context));
      if (blocked !== undefined) throw new GuardrailError(blocked);
    }
    if (this.active !== this.root && this.active.beforeStep) {
      const blocked = denial(yield* this.active.beforeStep(request, this.context));
      if (blocked !== undefined) throw new GuardrailError(blocked);
    }
    yield* this.updates.emit({type: "step-start", step: this.step});
    const atRequest = this.history.revision;
    const modelTask = this.tasks.track(this.active.model(request));
    const action = modelResponse((yield* this.waitFor({model: modelTask})).value);
    yield* this.updates.drainSteering(this.step);
    this.tools.collectResults();
    if ((action.chunks ?? []).reduce((n, c) => n + c.text.length, 0) > this.config.maxOutputChars)
      throw new AgentLimitError("Model chunks exceed maxOutputChars");
    for (const chunk of action.chunks ?? [])
      yield* this.updates.emit({type: "model-chunk", step: this.step, chunk});
    if ((action.text?.length ?? 0) > this.config.maxOutputChars)
      throw new AgentLimitError("Model output exceeds maxOutputChars");
    // A new steering message or background outcome invalidates the whole
    // plan, including calls that would cause side effects. Already-started
    // tool batches are allowed to settle and retain their results.
    yield* this.updates.drainSteering(this.step);
    this.tools.collectResults();
    return this.history.revision === atRequest ? action : undefined;
  }

  private *complete(action: ModelFinalResponse): Operation<RunResult<O> | undefined> {
    this.history.flush();
    if (this.tools.hasPending) {
      if (this.step < this.config.maxSteps) yield* this.waitFor({});
      return undefined;
    }
    let output: O;
    if (this.root.output) {
      let candidate: unknown = action.output;
      if (candidate === undefined) {
        try {
          candidate = JSON.parse(action.text);
        } catch {}
      }
      const parsed = this.root.output.safeParse(candidate);
      if (action.validationError || !parsed.success) {
        yield* this.updates.emit({
          type: "output-invalid",
          step: this.step,
          reason: action.validationError ?? "Output schema validation failed",
        });
        this.history.append({role: "assistant", content: action.text});
        this.history.observe({
          type: "output-invalid",
          instruction: "Return a final answer matching the requested output schema.",
        });
        return undefined;
      }
      output = parsed.data;
    } else {
      if (action.validationError) throw new ModelProtocolError(action.validationError);
      output = action.text as O;
    }
    return yield* this.finish({
      status: "completed",
      output,
      steps: this.step,
      messages: this.history.snapshot(),
    });
  }

  private *executeTools(action: ModelToolCallsResponse): Operation<void> {
    const foreground = yield* this.tools.startBatch(action, this.step, this.active, this.catalog);
    while (foreground.size) {
      const next = yield* this.waitFor(Object.fromEntries(foreground));
      foreground.delete(next.tag);
    }
    const transfer = this.tools.commitBatch();
    this.tools.collectResults();
    this.history.flush();
    if (transfer) {
      const from = this.active.name ?? "agent";
      this.active = transfer();
      this.catalog = createToolCatalog(this.active.tools);
      yield* this.updates.emit({
        type: "handoff",
        step: this.step,
        from,
        to: this.active.name ?? "agent",
      });
    }
  }

  private *waitFor(branches: FutureBranches): Operation<SelectionResult> {
    while (true) {
      const branchesToSelect: FutureBranches = {
        ...(this.updates.steeringReady ? {steering: this.updates.steeringReady} : {}),
        ...this.tools.pendingTasks(),
        ...branches,
      };
      const selected = yield* select(branchesToSelect);
      const value = yield* selected.future;
      if (selected.tag === "steering") {
        yield* this.updates.drainSteering(this.step);
        if (!Object.keys(branches).length) return {tag: "steering", value};
      } else if (selected.tag.startsWith("pending:")) {
        this.tools.collectResults();
        if (!Object.keys(branches).length) return {tag: selected.tag, value};
      } else return {tag: selected.tag, value};
    }
  }

  private *finish(result: RunResult<O>): Operation<RunResult<O> | undefined> {
    result = yield* summarizeStoppedRun(result, this.root.finalize);
    const beforeGuard = this.history.revision;
    if (this.root.afterRun) {
      const guarded = this.tasks.track(
        this.root.afterRun(createOutputCandidate(result), this.context),
      );
      yield* this.waitFor({guard: guarded});
      result = applyOutputDecision(result, yield* guarded);
    }
    if (
      result.status === "completed" &&
      (this.updates.hasSteering || this.history.revision !== beforeGuard)
    ) {
      // Steering may arrive while a generator output policy is awaiting I/O.
      // The candidate has not been published; replan against the new input.
      yield* this.updates.drainSteering(this.step);
      this.history.flush();
      return undefined;
    }
    yield* this.updates.stopSteering(new InterruptedError("Run is finalizing"));
    if (result.status === "completed") {
      if (this.root.output) result = {...result, output: this.root.output.parse(result.output)};
      else if (typeof result.output !== "string")
        throw new GuardrailError("A completed text run must have a string output");
    }
    const output = result.output === undefined ? undefined : jsonSchema.parse(result.output);
    if (output !== undefined && JSON.stringify(output).length > this.config.maxOutputChars)
      throw new AgentLimitError("Final output exceeds maxOutputChars");
    // From this point the answer is accepted. A late application interrupt
    // must not turn publication/cleanup into a second finalization attempt.
    this.tasks.beginFinalization();
    // Commit only the accepted output. An interrupted policy cannot leak its
    // candidate, and policy-provided stopped summaries get their own message.
    if (output !== undefined) {
      this.history.append({
        role: "assistant",
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
    result = {...result, messages: this.history.snapshot()};
    yield* this.history.save();
    yield* this.updates.emit({
      type: "run-end",
      step: this.step,
      status: result.status,
      ...(output === undefined ? {} : {output}),
    });
    return result;
  }

  private *stop(reason: InterruptedError): Operation<void> {
    yield* this.tasks.stop(reason);
    this.tools.commitBatch(reason.message);
    this.tools.settlePending(reason);
    yield* this.updates.drainSteering(this.step);
    this.history.flush();
  }
}
