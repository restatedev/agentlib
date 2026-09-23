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
} from "./errors.js";
import {RunHistory} from "./run-history.js";
import {RunTasks, type FutureBranches} from "./run-tasks.js";
import {RunTools} from "./run-tools.js";
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
  Message,
  RunContext,
  RunOptions,
  RunResult,
  SteeringSource,
  ToolResult,
} from "./types.js";

export type RunConfiguration = ToolExecutionLimits &
  Readonly<{
    maxSteps: number;
    maxOutputTokens: number;
    outputSchema?: Record<string, unknown>;
  }>;

type LlmOutcome =
  | {kind: "response"; response: ModelResponse}
  | {kind: "steer"; message: string}
  | {kind: "interrupt"; reason: string};

export function* runAgent<C, O>(
  input: string,
  root: AgentOptions<C, O>,
  config: RunConfiguration,
  options?: RunOptions<C>,
): Operation<RunResult<O>> {
  const history = yield* RunHistory.load(input, options);
  return yield* new AgentRun(root, config, history, options).run();
}

/** One conversation turn. The run alternates between model and tool phases. */
class AgentRun<C, O> {
  private step = 0;
  private steeringSource: SteeringSource | undefined;
  private steering: Future<string> | undefined;
  private interrupt: Future<string> | undefined;
  private active: AgentRuntime<C>;
  private catalog: ToolCatalog<C>;
  private readonly context: RunContext<C>;
  private readonly tasks: RunTasks;
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
    this.tasks = new RunTasks();
    this.tools = new RunTools(
      root,
      this.context,
      config,
      this.tasks,
      history,
      options?.onApproval?.bind(options),
    );
  }

  /** Data flow for one run:
   * runAgent has loaded prior messages once and appended this turn's user input.
   * Startup applies beforeRun and optional compaction; nothing is saved yet.
   * The LLM call races steering and interruption. The winning control returns
   * to this loop; the losing model task is interrupted and its response is
   * discarded. Completed background results are appended before acting on a
   * model response and likewise require a fresh request.
   * The tool phase races foreground calls with steering and interruption.
   * Each result is appended when selected. The model cannot read a partial
   * native tool-call batch, so the phase ends when its foreground calls settle.
   * The model-facing transcript then groups those results after their call.
   * Background calls receive pending acknowledgments immediately; their later
   * results enter history as new model-visible messages.
   * A final answer passes validation and afterRun before finish() appends the
   * accepted output and saves this turn. Interruption or a step limit first
   * settles owned work, then uses the same review/finish path. Unexpected
   * failures leave the turn unpersisted. */
  *run(): Operation<RunResult<O>> {
    try {
      // Startup has no model work to invalidate. Controls are received by the
      // first planning step after policy and conversation compaction finish.
      if (this.root.beforeRun) {
        const rejected = denial(yield* this.root.beforeRun(this.history.snapshot(), this.context));
        if (rejected !== undefined) throw new GuardrailError(rejected);
      }
      yield* this.history.compact();

      const controls = this.options?.controls;
      const steeringSignal = this.options?.steeringSignal;
      if (controls?.steering) {
        this.steeringSource = controls.steering.bind(controls);
      } else if (steeringSignal) {
        this.steeringSource = () => signal<string>(steeringSignal);
      }
      this.steering = this.steeringSource?.();
      this.interrupt = controls?.interrupt;
      if (!this.interrupt && this.options?.interruptSignal) {
        this.interrupt = signal<string>(this.options.interruptSignal);
      }

      let interruption: RunInterrupted | undefined;
      try {
        for (this.step = 1; this.step <= this.config.maxSteps; this.step++) {
          const outcome = yield* this.llm(this.history.snapshot());
          if (outcome.kind === "steer") {
            this.acceptSteering(outcome.message);
            continue;
          }
          if (outcome.kind === "interrupt") throw new RunInterrupted(outcome.reason);

          const completed = this.tools.drainCompleted();
          if (completed.length > 0) {
            this.history.append(...completed);
            continue;
          }

          const action = outcome.response;
          if (action.type === "final") {
            const result = yield* this.complete(action);
            if (result) return result;
          } else {
            yield* this.toolPhase(action);
          }
        }
      } catch (error) {
        if (!(error instanceof RunInterrupted)) throw error;
        interruption = error;
      }

      if (!interruption) this.step = this.config.maxSteps;
      // Stopped-run finalization stays outside the control catch, so its
      // failures propagate instead of starting another stop attempt.
      yield* this.stop(interruption ?? new InterruptedError("Maximum model steps reached"));
      const end = {steps: this.step, messages: this.history.snapshot()};
      let result: RunResult<O>;
      if (interruption) {
        result = {
          ...end,
          status: "interrupted",
          reason: interruption.message,
        };
      } else {
        result = {
          ...end,
          status: "stopped",
          reason: "max_steps",
        };
      }
      return yield* this.finish(yield* this.reviewOutput(result));
    } finally {
      yield* this.tasks.close();
    }
  }

  private *plan(messages: Message[]): Operation<ModelResponse> {
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
      messages,
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
    const action = modelResponse(yield* this.active.model(request));
    if ((action.chunks ?? []).reduce((n, c) => n + c.text.length, 0) > this.config.maxOutputChars)
      throw new AgentLimitError("Model chunks exceed maxOutputChars");
    if ((action.text?.length ?? 0) > this.config.maxOutputChars)
      throw new AgentLimitError("Model output exceeds maxOutputChars");
    return action;
  }

  /** Race one model request with controls; never change conversation history. */
  private *llm(messages: Message[]): Operation<LlmOutcome> {
    const model = this.tasks.spawn(this.plan(messages));
    const branches: FutureBranches = {failed: this.tasks.failed};
    if (this.interrupt) branches.interrupt = this.interrupt;
    if (this.steering) branches.steering = this.steering;
    branches.model = model;
    const selected = yield* select(branches);
    const value = yield* selected.future;
    if (selected.tag === "failed") throw value;
    if (selected.tag === "model") return {kind: "response", response: value as ModelResponse};
    yield* this.discardModel(model);
    if (selected.tag === "steering") {
      if (typeof value !== "string" || !value.trim())
        throw new TypeError("Steering must be a nonempty string");
      return {kind: "steer", message: value};
    }
    if (selected.tag === "interrupt") {
      if (typeof value !== "string") throw new TypeError("Interruption reason must be a string");
      return {kind: "interrupt", reason: value};
    }
    throw new Error(`Unexpected LLM branch: ${selected.tag}`);
  }

  private *discardModel(model: Task<ModelResponse>): Operation<void> {
    model.interrupt(new InterruptedError("Model response superseded by a control"));
    try {
      yield* model;
    } catch (error) {
      if (!(error instanceof InterruptedError)) throw error;
    }
  }

  private *complete(action: ModelFinalResponse): Operation<RunResult<O> | undefined> {
    if (this.tools.hasPending) {
      // A pending tool should not hold a later steer hostage. Either its
      // result or new steering gives the model a reason to reconsider.
      if (this.step < this.config.maxSteps) yield* this.pendingToolPhase();
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
        this.history.append(
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
      output = parsed.data;
    } else {
      if (action.validationError) throw new ModelProtocolError(action.validationError);
      output = action.text as O;
    }
    const result = yield* this.reviewPhase({
      status: "completed",
      output,
      steps: this.step,
      messages: this.history.snapshot(),
    });
    if (!result) return undefined;
    return yield* this.finish(result);
  }

  private *toolPhase(action: ModelToolCallsResponse): Operation<void> {
    const foreground = this.tools.startBatch(action, this.step, this.active, this.catalog);
    while (Object.keys(foreground).length > 0) {
      const branches: FutureBranches = {
        failed: this.tasks.failed,
        ...foreground,
        ...this.tools.pendingTasks(),
      };
      if (this.steering) branches.steering = this.steering;
      if (this.interrupt) branches.interrupt = this.interrupt;
      const selected = yield* select(branches);
      const value = yield* selected.future;
      if (selected.tag === "failed") throw value;
      if (selected.tag === "interrupt") {
        if (typeof value !== "string") throw new TypeError("Interruption reason must be a string");
        throw new RunInterrupted(value);
      }
      if (selected.tag === "steering") {
        this.acceptSteering(value);
      } else if (selected.tag.startsWith("tool:")) {
        this.tools.recordResult(selected.tag.slice(5), value as ToolResult);
        delete foreground[selected.tag];
      } else if (selected.tag.startsWith("pending:")) {
        this.history.append(...this.tools.drainCompleted());
      } else {
        throw new Error(`Unexpected tool-phase branch: ${selected.tag}`);
      }
    }
    const transfer = this.tools.commitBatch();
    this.history.append(...this.tools.drainCompleted());
    if (transfer) {
      this.active = transfer();
      this.catalog = createToolCatalog(this.active.tools);
    }
  }

  /** A final answer cannot complete while a background tool is pending. */
  private *pendingToolPhase(): Operation<void> {
    const branches: FutureBranches = {failed: this.tasks.failed, ...this.tools.pendingTasks()};
    if (this.interrupt) branches.interrupt = this.interrupt;
    if (this.steering) branches.steering = this.steering;
    const selected = yield* select(branches);
    const value = yield* selected.future;
    if (selected.tag === "failed") throw value;
    if (selected.tag === "interrupt") {
      if (typeof value !== "string") throw new TypeError("Interruption reason must be a string");
      throw new RunInterrupted(value);
    }
    if (selected.tag === "steering") {
      this.acceptSteering(value);
      return;
    }
    if (!selected.tag.startsWith("pending:"))
      throw new Error(`Unexpected pending-tool branch: ${selected.tag}`);
    this.history.append(...this.tools.drainCompleted());
  }

  /** Review is another candidate operation: steering can invalidate it before
   * its output is accepted, and interruption cancels it immediately. */
  private *reviewPhase(candidate: RunResult<O>): Operation<RunResult<O> | undefined> {
    const review = this.tasks.spawn(this.reviewOutput(candidate));
    let changed = false;
    while (true) {
      const branches: FutureBranches = {failed: this.tasks.failed, review};
      if (this.steering) branches.steering = this.steering;
      if (this.interrupt) branches.interrupt = this.interrupt;
      const selected = yield* select(branches);
      const value = yield* selected.future;
      if (selected.tag === "failed") throw value;
      if (selected.tag === "interrupt") {
        if (typeof value !== "string") throw new TypeError("Interruption reason must be a string");
        throw new RunInterrupted(value);
      }
      if (selected.tag === "steering") {
        this.acceptSteering(value);
        changed = true;
        continue;
      }
      if (selected.tag !== "review")
        throw new Error(`Unexpected review-phase branch: ${selected.tag}`);
      return changed ? undefined : (value as RunResult<O>);
    }
  }

  private acceptSteering(value: unknown): void {
    if (typeof value !== "string" || !value.trim())
      throw new TypeError("Steering must be a nonempty string");
    const source = this.steeringSource;
    if (!source) throw new Error("Steering source is not configured");
    const message: Message = {
      role: "user",
      content: JSON.stringify({source: "agent-runtime", type: "steering", message: value}),
    };
    this.history.append(message);
    this.steering = source();
  }

  private *reviewOutput(result: RunResult<O>): Operation<RunResult<O>> {
    result = yield* summarizeStoppedRun(result, this.root.finalize);
    if (this.root.afterRun) {
      const decision = yield* this.root.afterRun(createOutputCandidate(result), this.context);
      result = applyOutputDecision(result, decision);
    }
    return result;
  }

  private *finish(result: RunResult<O>): Operation<RunResult<O>> {
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
    this.steering = undefined;
    this.interrupt = undefined;
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
    return result;
  }

  private *stop(reason: InterruptedError): Operation<void> {
    this.steering = undefined;
    this.interrupt = undefined;
    yield* this.tasks.stop(reason);
    this.tools.commitBatch(reason.message);
    this.history.append(...this.tools.settlePending(reason));
  }
}
