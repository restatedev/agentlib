import {
  handlerRequest,
  InterruptedError,
  select,
  signal,
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
  ToolBudgetExceeded,
} from "./errors.js";
import {RunHistory} from "./run-history.js";
import {RunTasks, type FutureBranches} from "./run-tasks.js";
import {RunTools} from "./run-tools.js";
import {createToolCatalog, type ToolCatalog} from "./tool-catalog.js";
import type {ToolExecutionLimits} from "./tool-executor.js";
import {applyOutputDecision, createOutputCandidate, summarizeStoppedRun} from "./run-output.js";
import {jsonSchema, modelResponse, steeringUpdate} from "./validation.js";
import type {
  AgentOptions,
  AgentRuntime,
  GuardrailResult,
  Message,
  ModelFinalResponse,
  ModelResponse,
  ModelToolCallsResponse,
  ProgressEvent,
  RunContext,
  RunControls,
  RunOptions,
  RunResult,
  SteeringSource,
  SteeringUpdate,
} from "./types.js";

export type RunConfiguration = ToolExecutionLimits &
  Readonly<{
    maxSteps: number;
    maxOutputTokens: number;
    outputSchema?: Record<string, unknown>;
  }>;

export function* runAgent<C, O>(
  input: string,
  root: AgentOptions<C, O>,
  config: RunConfiguration,
  options?: RunOptions<C>,
): Operation<RunResult<O>> {
  const history = yield* RunHistory.load(input, options);
  return yield* new AgentRun(root, config, history, options).run();
}

function allow(result: GuardrailResult): void {
  const rejected = denial(result);
  if (rejected !== undefined) throw new GuardrailError(rejected);
}

/** Explicit controls take precedence over named invocation signals. */
function resolveControls<C>(options?: RunOptions<C>): RunControls {
  const controls = options?.controls;
  let steering = controls?.steering?.bind(controls);
  const steeringSignal = options?.steeringSignal;
  if (!steering && steeringSignal) steering = () => signal<string>(steeringSignal);
  let interrupt = controls?.interrupt;
  if (!interrupt && options?.interruptSignal) interrupt = signal<string>(options.interruptSignal);
  return {steering, interrupt};
}

/** One conversation turn: runAgent loads prior messages and appends the user
 * input, then the run alternates model and tool phases until it completes.
 *
 * Every wait goes through race(), which also watches controls and task failures:
 * - Steering is appended to history the moment it arrives. Work whose result
 *   depends on history (a model request, output review) is a candidate and is
 *   discarded; tool calls keep running because their results stay valid.
 * - Interruption and the step limit settle owned work, then share one
 *   review/finish path. Controls are no longer raced from there on, so a late
 *   interrupt cannot restart finalization.
 * - Background results completed during a model request also invalidate its
 *   response: the model must see them before acting.
 *
 * Nothing is saved until finish() persists the turn; failures save nothing. */
class AgentRun<C, O> {
  private step = 0;
  private steeringSource: SteeringSource | undefined;
  private steering: Future<string | SteeringUpdate> | undefined;
  private interrupt: Future<string> | undefined;
  private active: AgentRuntime<C>;
  private catalog: ToolCatalog<C>;
  private readonly context: RunContext<C>;
  private readonly tasks = new RunTasks();
  private readonly tools: RunTools<C>;

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
    this.tools = new RunTools(
      root,
      this.context,
      config,
      this.tasks,
      history,
      (event) => this.emit(event),
      options?.onApproval?.bind(options),
    );
  }

  *run(): Operation<RunResult<O>> {
    try {
      yield* this.start();
      let stop: RunInterrupted | ToolBudgetExceeded | undefined;
      try {
        const result = yield* this.steps();
        if (result) return result;
      } catch (error) {
        if (!(error instanceof RunInterrupted || error instanceof ToolBudgetExceeded)) throw error;
        stop = error;
      }
      // Outside the catch: a failing stop propagates instead of stopping twice.
      return yield* this.stop(stop);
    } finally {
      yield* this.tasks.close();
    }
  }

  /** Startup has no model work to supersede, so controls attach afterwards. */
  private *start(): Operation<void> {
    if (this.root.beforeRun)
      allow(yield* this.root.beforeRun(this.history.snapshot(), this.context));
    yield* this.history.compact();
    const controls = resolveControls(this.options);
    this.steeringSource = controls.steering;
    this.steering = controls.steering?.();
    this.interrupt = controls.interrupt;
  }

  /** Returns the completed result, or undefined when the step budget runs out. */
  private *steps(): Operation<RunResult<O> | undefined> {
    for (this.step = 1; this.step <= this.config.maxSteps; this.step++) {
      yield* this.emit({type: "step", step: this.step});
      const response = yield* this.candidate(this.plan(this.history.snapshot()));
      if (!response || this.collectBackground()) continue;
      if (response.type === "tool_calls") {
        yield* this.toolPhase(response);
        continue;
      }
      const result = yield* this.complete(response);
      if (result) return result;
    }
    return undefined;
  }

  /** Waits for one branch or a control. Failures and interruption throw;
   * steering is recorded and reported under the "steering" tag. */
  private *race(branches: FutureBranches): Operation<{tag: string; value: unknown}> {
    const controls: FutureBranches = {failed: this.tasks.failed};
    if (this.interrupt) controls.interrupt = this.interrupt;
    if (this.steering) controls.steering = this.steering;
    const {tag, future} = yield* select({...controls, ...branches});
    const value = yield* future;
    if (tag === "failed") throw value;
    if (tag === "interrupt") {
      if (typeof value !== "string") throw new TypeError("Interruption reason must be a string");
      throw new RunInterrupted(value);
    }
    if (tag === "steering") {
      const {message, data} = this.acceptSteering(value);
      yield* this.emit({type: "steering", message, ...(data === undefined ? {} : {data})});
    }
    return {tag, value};
  }

  private *emit(event: ProgressEvent): Operation<void> {
    // Called as a method, so a handler can use `this`, like onApproval.
    if (this.options?.onProgress)
      yield* this.options.onProgress(structuredClone(event), this.context.context);
  }

  /** Runs work that steering supersedes; returns undefined when it was discarded. */
  private *candidate<T>(operation: Operation<T>): Operation<T | undefined> {
    const task = this.tasks.spawn(operation);
    const {tag, value} = yield* this.race({candidate: task});
    if (tag === "candidate") return value as T;
    yield* this.discard(task);
    return undefined;
  }

  private *discard(task: Task<unknown>): Operation<void> {
    task.interrupt(new InterruptedError("Superseded by steering"));
    try {
      yield* task;
    } catch (error) {
      if (!(error instanceof InterruptedError)) throw error;
    }
  }

  private *plan(messages: Message[]): Operation<ModelResponse> {
    const {active} = this;
    const request = {
      // Called as a method, so an instructions function can use `this`.
      instructions:
        typeof active.instructions === "function"
          ? yield* active.instructions(this.context)
          : active.instructions,
      outputSchema: this.config.outputSchema,
      maxOutputTokens: this.config.maxOutputTokens,
      step: this.step,
      messages,
      tools: this.catalog.visibleManifests(),
    };
    // The root's policy applies to every step; a handoff target adds its own.
    for (const agent of new Set<AgentRuntime<C>>([this.root, this.active])) {
      if (agent.beforeStep) allow(yield* agent.beforeStep(request, this.context));
    }
    const response = modelResponse(yield* this.active.model(request));
    if ((response.text?.length ?? 0) > this.config.maxOutputChars)
      throw new AgentLimitError("Model output exceeds maxOutputChars");
    return response;
  }

  /** Runs one native tool-call batch. The model cannot read a partial batch, so
   * the phase lasts until every foreground call settles; background calls were
   * acknowledged as pending and report later through collectBackground().
   * Steering does not wait for a running program: it continues in the background. */
  private *toolPhase(action: ModelToolCallsResponse): Operation<void> {
    const foreground = this.tools.startBatch(action, this.step, this.active, this.catalog);
    while (Object.keys(foreground).length > 0) {
      const {tag} = yield* this.race({...foreground, ...this.tools.pendingTasks()});
      if (tag === "steering") {
        for (const name of this.tools.handOffPrograms()) delete foreground[name];
        continue;
      }
      delete foreground[tag];
      this.collectBackground();
    }
    const transfer = this.tools.commitBatch();
    this.collectBackground();
    if (transfer) {
      this.active = transfer();
      yield* this.emit({type: "handoff", agent: this.active.name});
      // Run-level tools belong to the run, not the agent, so they survive a handoff.
      this.catalog = createToolCatalog(this.active.tools, this.options?.tools);
    }
  }

  /** Moves finished background results into history; true when any arrived. */
  private collectBackground(): boolean {
    const completed = this.tools.drainCompleted();
    this.history.append(...completed);
    return completed.length > 0;
  }

  private *complete(action: ModelFinalResponse): Operation<RunResult<O> | undefined> {
    if (this.tools.hasPending) {
      // A final answer cannot complete while background work is outstanding.
      // Its result, or steering, gives the model a reason to reconsider.
      if (this.step < this.config.maxSteps) {
        yield* this.race(this.tools.pendingTasks());
        this.collectBackground();
      }
      return undefined;
    }
    const parsed = this.parseOutput(action);
    if (!parsed) {
      // The model needs its rejected answer to correct it; the turn must not keep it.
      this.history.appendProvisional(
        {role: "assistant", content: action.text},
        {
          role: "user",
          content: JSON.stringify({
            source: "agent-runtime",
            type: "output-invalid",
            instruction: "Return a final answer matching the requested output schema.",
          }),
        },
      );
      return undefined;
    }
    const result = yield* this.candidate(
      this.review({
        status: "completed",
        output: parsed.output,
        steps: this.step,
        messages: this.history.committed(),
      }),
    );
    return result && (yield* this.finish(result));
  }

  /** Returns undefined when the model should retry against the output schema. */
  private parseOutput(action: ModelFinalResponse): {output: O} | undefined {
    if (!this.root.output) {
      if (action.validationError) throw new ModelProtocolError(action.validationError);
      return {output: action.text as O};
    }
    let candidate: unknown = action.output;
    if (candidate === undefined) {
      try {
        candidate = JSON.parse(action.text);
      } catch {}
    }
    const parsed = this.root.output.safeParse(candidate);
    if (action.validationError || !parsed.success) return undefined;
    return {output: parsed.data};
  }

  private acceptSteering(value: unknown): SteeringUpdate {
    const update = steeringUpdate.safeParse(typeof value === "string" ? {message: value} : value);
    if (!update.success) throw new TypeError("Steering must be a nonempty message");
    const {message} = update.data;
    this.history.append({
      role: "user",
      content: JSON.stringify({source: "agent-runtime", type: "steering", message}),
    });
    // A steering future only exists when its source does.
    this.steering = this.steeringSource!();
    return update.data;
  }

  private *review(result: RunResult<O>): Operation<RunResult<O>> {
    const finalize = this.root.finalize ?? this.root.model;
    if (finalize) result = yield* summarizeStoppedRun(result, finalize);
    if (this.root.afterRun) {
      const decision = yield* this.root.afterRun(createOutputCandidate(result), this.context);
      result = applyOutputDecision(result, decision);
    }
    return result;
  }

  /** Ends a run that did not complete: settles owned work, then reviews and saves.
   * Without a cause, the run used its last step. */
  private *stop(cause: RunInterrupted | ToolBudgetExceeded | undefined): Operation<RunResult<O>> {
    const reason =
      cause instanceof RunInterrupted
        ? cause
        : new InterruptedError(cause?.message ?? "Maximum model steps reached");
    yield* this.tasks.stop(reason);
    this.tools.commitBatch(reason.message);
    this.history.append(...this.tools.settlePending(reason));
    const end = {
      steps: Math.min(this.step, this.config.maxSteps),
      messages: this.history.committed(),
    };
    let result: RunResult<O>;
    if (cause instanceof RunInterrupted)
      result = {...end, status: "interrupted", reason: cause.message};
    else if (cause) result = {...end, status: "stopped", reason: "max_tool_calls"};
    else result = {...end, status: "stopped", reason: "max_steps"};
    return yield* this.finish(yield* this.review(result));
  }

  /** Validates the accepted result, commits its output, and saves the turn. */
  private *finish(result: RunResult<O>): Operation<RunResult<O>> {
    if (result.status === "completed") {
      if (this.root.output) {
        const parsed = this.root.output.safeParse(result.output);
        if (!parsed.success)
          throw new GuardrailError(
            `Run output does not match the output schema: ${parsed.error.message}`,
          );
        result = {...result, output: parsed.data};
      } else if (typeof result.output !== "string")
        throw new GuardrailError("A completed text run must have a string output");
    }
    const output = result.output === undefined ? undefined : finalOutput(result.output);
    if (output !== undefined && JSON.stringify(output).length > this.config.maxOutputChars)
      throw new AgentLimitError("Final output exceeds maxOutputChars");
    // Only accepted output reaches history: a discarded candidate never does,
    // and a policy-provided stopped summary gets its own message.
    if (output !== undefined) {
      this.history.append({
        role: "assistant",
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
    yield* this.history.save();
    return {...result, messages: this.history.committed()};
  }
}

function finalOutput(value: unknown) {
  const parsed = jsonSchema.safeParse(value);
  if (!parsed.success) throw new GuardrailError("Run output must be JSON");
  return parsed.data;
}
