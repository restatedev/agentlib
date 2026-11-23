import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  InterruptedError,
  logger,
  select,
  signal,
  type Future,
  type Operation,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {
  ContextOverflowError,
  GuardrailError,
  guardrailDecision,
  isContextOverflow,
  isResponseProblem,
  mustPropagate,
  reachesModel,
  RunInterrupted,
  ToolBudgetExceeded,
  ToolError,
  toolErrorCode,
} from "./errors.js";
import {ConversationConflictError} from "./conversation.js";
import {recordFailedHistory, RunHistory, type BranchPoint} from "./run-history.js";
import {RunTasks, type FutureBranches} from "./run-tasks.js";
import {RunTools} from "./run-tools.js";
import {PARENT_USAGE, recordFailedRun, RunUsageTracker} from "./run-usage.js";
import {FORK_PREAMBLE, FORK_SOURCE, type ForkSource} from "./fork.js";
import type {ForkLimits} from "./fork-source.js";
import {createToolCatalog, type ToolCatalog} from "./tool-catalog.js";
import {forwardProgress, type ToolExecutionLimits} from "./tool-executor.js";
import {applyOutputDecision, createOutputCandidate, summarizeStoppedRun} from "./run-output.js";
import {summarizeContext, truncateContext} from "./context-compaction.js";
import {estimateTokens, jsonTokens, textTokens} from "./context-size.js";
import {READ_TOOL, readToolResultTool, type PreviewSettings} from "./tool-result-preview.js";
import {listSkills, skillsSection, skillTools} from "./skills.js";
import {SEARCH_TOOL, searchToolsTool} from "./builtins.js";
import {PROGRAM_TOOL, programTool} from "./program.js";
import {jsonSchema, modelResponse, stepMessages, steeringUpdate} from "./validation.js";
import type {
  AgentOptions,
  AgentRuntime,
  Message,
  ModelFinalResponse,
  ModelRequest,
  ModelResponse,
  ModelToolCallsResponse,
  ReadonlyMessage,
  Reasoning,
  ToolManifest,
  ProgressEvent,
  RunContext,
  RunControls,
  RunOptions,
  RunResult,
  SteeringSource,
  SteeringUpdate,
  Tool,
  ToolContext,
} from "./types.js";

export type RunConfiguration = ToolExecutionLimits &
  Readonly<{
    maxSteps: number;
    maxOutputTokens: number;
    outputSchema?: Record<string, unknown>;
    compaction?: {maxTokens: number; retainTokens: number};
    toolResults?: PreviewSettings;
    contextWindow?: number;
  }>;

// The tools a run adds by default hold no state, so every run shares them.
const defaultSearch = searchToolsTool();
const defaultProgram = programTool();

export function* runAgent<C, O>(
  input: string,
  root: AgentOptions<C, O>,
  config: RunConfiguration,
  options?: RunOptions<C>,
): Operation<RunResult<O>> {
  // Set by agentTool when this run is a sub-agent of another run.
  const parent = (options as {[PARENT_USAGE]?: RunUsageTracker} | undefined)?.[PARENT_USAGE];
  const usage = new RunUsageTracker();
  try {
    const history = yield* RunHistory.load(input, options, config.toolResults);
    return yield* new AgentRun(root, config, history, usage, options).run();
  } catch (error) {
    // Rethrow the same value: Restate's retry and cancellation handling depend on its type.
    recordFailedRun(error, usage.snapshot());
    throw error;
  } finally {
    // A sub-agent counts toward its parent, whatever its outcome.
    parent?.add(usage.snapshot());
  }
}

type Skills<C> = {section: string; tools: Record<string, Tool<C>>};

/** The run state a fork copies, as it stood when a step's tool batch started. */
type ForkPoint<C> = {
  history: BranchPoint;
  active: AgentRuntime<C>;
  /** Deferred tools that search had loaded. */
  loaded: readonly string[];
};

/** What a fork's run starts with instead of listing skills and running beforeRun. */
type ForkOrigin<C> = {
  active: AgentRuntime<C>;
  skills: Skills<C> | undefined;
  loaded: readonly string[];
};

/** Where a failure the model receives as a note came from. */
type NoteOrigin = ErrorNoteEvent["origin"];
type ErrorNoteEvent = Extract<ProgressEvent, {type: "error-note"}>;
/** Work that failed in a way the model receives: the note it gets instead, and
 * the progress event that reports it. */
type Rejection = {rejected: Message; event: ErrorNoteEvent};

/** The note for an error the model receives; any other error propagates. The note
 * tells the model why a step produced nothing, so it can try again. It is
 * provisional: the model sees it for the rest of the run, but it is never saved. */
function rejection(origin: NoteOrigin, error: unknown): Rejection {
  if (!reachesModel(error)) throw error;
  const code = toolErrorCode(error);
  const details = {origin, ...(code === undefined ? {} : {code}), message: error.message};
  return {
    rejected: {
      role: "user",
      content: JSON.stringify({source: "agent-runtime", type: "error", ...details}),
    },
    event: {type: "error-note", ...details},
  };
}

/** A final answer as the model gave it, for a model that must revise it. */
function answer(action: ModelFinalResponse): Message {
  return {
    role: "assistant",
    content: action.text,
    ...(action.reasoning ? {reasoning: structuredClone(action.reasoning)} : {}),
  };
}

/** The text an output is recorded as. */
function recorded(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/** The agent's instructions followed by its skills section. */
function withSkills(instructions: string | undefined, section: string | undefined) {
  if (!section) return instructions;
  return instructions ? `${instructions}\n\n${section}` : section;
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
 * With a conversation, the run saves after each model call that returns tool calls
 * and after accepted steering, so a shared handler can read its progress, and when
 * the turn ends: finish() commits the answer, and a failed run saves its committed
 * history with a note on the failure; see fail(). A batch's calls are saved before
 * they run; their results and background results are saved with the next save.
 * Progress events report them as they happen. */
class AgentRun<C, O> {
  private step = 0;
  private steeringSource: SteeringSource | undefined;
  private steering: Future<string | SteeringUpdate> | undefined;
  private interrupt: Future<string> | undefined;
  /** Set once a summary failed; the run truncates from then on. */
  private compactionFailed = false;
  /** Set once `beforeRun` accepted the input; a fork's input needs no check. */
  private inputChecked: boolean;
  /** The last request without its messages: the prefix a provider cached.
   * Its instructions may come from a function. */
  private lastRequest: Pick<ModelRequest, "instructions" | "tools"> | undefined;
  private active: AgentRuntime<C>;
  private catalog: ToolCatalog<C>;
  /** The root agent's skills, listed once at the start of the run. */
  private skills: Skills<C> | undefined;
  /** Each step's fork point, by step: a fork started by a call in that step
   * copies the run as it stood then, even when the call starts later. */
  private readonly forkPoints = new Map<number, ForkPoint<C>>();
  /** Forks of this run that are running now, by the limits of the tool that started them. */
  private readonly runningForks = new Map<ForkLimits, number>();
  private readonly context: RunContext<C>;
  private readonly tasks = new RunTasks();
  private readonly tools: RunTools<C>;

  constructor(
    private readonly root: AgentOptions<C, O>,
    private readonly config: RunConfiguration,
    private readonly history: RunHistory,
    private readonly usage: RunUsageTracker,
    private readonly options?: RunOptions<C>,
    /** Set when this run is a fork of another run. */
    private readonly origin?: ForkOrigin<C>,
  ) {
    this.active = origin?.active ?? root;
    this.inputChecked = origin !== undefined;
    this.skills = origin?.skills;
    this.catalog = createToolCatalog(this.active.tools, this.runTools());
    for (const name of origin?.loaded ?? []) this.catalog.search.loaded.add(name);
    this.context = {
      context: options?.context as C,
      invocationId: handlerRequest().id,
      name: options?.name ?? root.name ?? "agent",
      // Tool contexts copy this context, so agentTool can link a sub-agent run to
      // this one, and the fork tool can copy this run.
      [PARENT_USAGE]: usage,
      [FORK_SOURCE]: {
        forked: origin !== undefined,
        fork: (task, call, limits) => this.fork(task, call as ToolContext<C>, limits),
      } satisfies ForkSource,
    } as RunContext<C>;
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
    } catch (error) {
      yield* this.fail(error);
      // The same value: Restate's retry and cancellation handling depend on its type.
      throw error;
    } finally {
      yield* this.tasks.close();
    }
  }

  /** Startup has no model work to supersede, so controls attach afterwards.
   * A fork continues a run that already started: its input is a tool call's,
   * and it keeps the skills the run listed. */
  private *start(): Operation<void> {
    if (this.origin) return;
    const rejected = yield* this.checkInput();
    this.inputChecked = true;
    const source = this.root.skills;
    const listed = source ? yield* listSkills(source) : [];
    if (source && listed.length) {
      this.skills = {
        section: skillsSection(listed, source.read !== undefined),
        tools: skillTools<C>(source, listed),
      };
      this.catalog = createToolCatalog(this.active.tools, this.runTools());
    }
    yield* this.compactConversation();
    // Compaction rebuilds the message list, so the note follows it.
    if (rejected) yield* this.reject(rejected);
    const controls = resolveControls(this.options);
    this.steeringSource = controls.steering;
    this.steering = controls.steering?.();
    this.interrupt = controls.interrupt;
  }

  /** Applies `beforeRun`. A rejection, or a failure the model receives, becomes a
   * note after the input, and the first model call still goes ahead. */
  private *checkInput(): Operation<Rejection | undefined> {
    if (!this.root.beforeRun) return undefined;
    try {
      const result = yield* this.root.beforeRun(this.history.snapshot(), this.context);
      const decision = guardrailDecision("beforeRun", result, "message");
      if (decision && "reject" in decision) throw new GuardrailError(decision.reject, "denied");
      if (decision) this.history.replaceInput(decision.replace);
      return undefined;
    } catch (error) {
      return rejection("beforeRun", error);
    }
  }

  /** Compacts the conversation before the run. A failure leaves the history as it
   * was loaded, the way a failed summary inside the run falls back to truncation. */
  private *compactConversation(): Operation<void> {
    try {
      yield* this.history.compact();
    } catch (error) {
      if (mustPropagate(error)) throw error;
      logger().warn("Conversation compaction failed; the run continues without it:", error);
    }
  }

  /** Returns the completed result, or undefined when the step budget runs out. */
  private *steps(): Operation<RunResult<O> | undefined> {
    for (this.step = 1; this.step <= this.config.maxSteps; this.step++) {
      yield* this.emit({type: "step", step: this.step});
      yield* this.compactContext();
      const response = yield* this.ask();
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
   * accepted steering is recorded and reported under the "steering" tag. Rejected
   * steering changes nothing, so the race keeps waiting for the same branches. */
  private *race(branches: FutureBranches): Operation<{tag: string; value: unknown}> {
    for (;;) {
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
      if (tag === "steering" && !(yield* this.acceptSteering(value))) continue;
      return {tag, value};
    }
  }

  /** Asks the model for the next step; undefined when steering discarded it, or
   * when the step failed in a way the model receives as a note.
   * A view the model rejects as too long is shrunk once, then asked again. */
  private *ask(): Operation<ModelResponse | undefined> {
    for (let recovered = false; ; recovered = true) {
      const mark = this.history.mark();
      // Caught inside the candidate: a failed task would fail the whole run.
      const outcome = yield* this.candidate(this.overflowing(this.plan(this.history.snapshot())));
      if (outcome && "overflow" in outcome) {
        if (recovered || !(yield* this.compactContext(true))) throw outcome.overflow;
        continue;
      }
      if (outcome && "rejected" in outcome) {
        yield* this.reject(outcome);
        return undefined;
      }
      if (outcome?.usage) this.history.measure(mark, outcome.usage.inputTokens);
      return outcome;
    }
  }

  private *overflowing<T>(request: Operation<T>): Operation<T | {overflow: ContextOverflowError}> {
    try {
      return yield* request;
    } catch (error) {
      if (!isContextOverflow(error)) throw error;
      // Replay restores a journaled overflow as a plain TerminalError.
      return {overflow: new ContextOverflowError((error as Error).message)};
    }
  }

  /** Shrinks the model's view: past `compaction.maxTokens`, when the next
   * request would not fit `contextWindow`, or always after an overflow, which
   * keeps at most half of the view. A summary comes first when compaction is
   * set; truncation needs no model, so it is the fallback.
   * Not raced against controls: steering and interrupts are handled once the
   * smaller view is in place, so a stopped run still has room to finalize. */
  private *compactContext(overflow = false): Operation<boolean> {
    const {compaction: settings, contextWindow, maxOutputTokens} = this.config;
    // Measuring the view is only worth its cost when something can act on the result.
    if (!overflow && !settings && !contextWindow) return false;
    const retain = (limit: number) => Math.min(settings?.retainTokens ?? limit, limit);
    const overhead = this.requestOverhead();
    // Retained messages share a limit with instructions and tools; keeping
    // them to half of what remains leaves room for the note and the next step,
    // so the following step does not compact again.
    const room = (limit: number) => Math.max(1, Math.floor((limit - overhead) / 2));
    let reason: "threshold" | "window" | "overflow";
    let retainTokens: number;
    if (overflow) {
      reason = "overflow";
      retainTokens = retain(Math.floor(estimateTokens(this.history.snapshot()) / 2));
    } else {
      const tokens = this.history.viewTokens(overhead);
      if (settings && tokens > settings.maxTokens) {
        reason = "threshold";
        retainTokens = Math.min(settings.retainTokens, room(settings.maxTokens));
      } else if (contextWindow && tokens + maxOutputTokens > contextWindow) {
        reason = "window";
        retainTokens = retain(
          Math.min(Math.floor(contextWindow / 4), room(contextWindow - maxOutputTokens)),
        );
      } else return false;
    }
    const pending = this.tools.pendingCalls();
    if (settings && !this.compactionFailed) {
      const model = this.root.compaction?.model ?? this.root.model;
      // The note can reuse the cached prefix of the last request when the same
      // model writes it; a window or overflow cut means that prefix no longer fits.
      const prefix =
        reason === "threshold" && model === this.active.model && this.lastRequest
          ? {...this.lastRequest, maxOutputTokens}
          : undefined;
      try {
        const counted = this.usage.count(model);
        if (
          yield* summarizeContext(this.history, {model: counted, retainTokens, prefix}, pending)
        ) {
          yield* this.emit({type: "compaction", mode: "summary", status: "applied", reason});
          return true;
        }
      } catch (error) {
        if (mustPropagate(error)) throw error;
        // Summaries stop for this run; truncation keeps it within bounds.
        this.compactionFailed = true;
        yield* this.emit({
          type: "compaction",
          mode: "summary",
          status: "failed",
          reason,
          error: String(error),
        });
      }
    }
    if (!truncateContext(this.history, retainTokens, pending)) return false;
    yield* this.emit({type: "compaction", mode: "truncate", status: "applied", reason});
    return true;
  }

  /** Estimated tokens a request adds to its messages: instructions and tools.
   * Instructions a function computes count once a request has used them. */
  private requestOverhead(): number {
    const {instructions} = this.active;
    const text =
      typeof instructions === "function"
        ? (this.lastRequest?.instructions ?? "")
        : (withSkills(instructions, this.skills?.section) ?? "");
    return textTokens(text) + jsonTokens(JSON.stringify(this.visibleTools()));
  }

  /** The reader is listed from the first step, before any preview: a tool that
   * appeared mid-run would change the cached prefix. An agent with no other
   * tools gets no new results, so it lists the reader only for previews in
   * the history it loaded. */
  private visibleTools(): ToolManifest[] {
    const tools = this.catalog.visibleManifests();
    const readerOnly = tools.length === 1 && tools[0]!.name === READ_TOOL;
    return readerOnly && !this.history.hasPreviews() ? [] : tools;
  }

  /** Tools that belong to the run rather than an agent, so they survive a handoff.
   * Search and code mode depend on the active agent's tools, so the run
   * decides on them again after a handoff. */
  private runTools(): Record<string, Tool<C>> {
    const tools = {...this.options?.tools};
    const own = [...Object.values(this.active.tools ?? {}), ...Object.values(tools)];
    const added = {...this.skills?.tools, ...this.defaultTools(own)};
    for (const [name, runTool] of Object.entries(added)) {
      if (name in tools) throw new TypeError(`Duplicate tool name: ${name}`);
      tools[name] = runTool;
    }
    const settings = this.config.toolResults;
    if (!settings) return tools;
    if (READ_TOOL in tools) throw new TypeError(`Duplicate tool name: ${READ_TOOL}`);
    tools[READ_TOOL] = readToolResultTool<C>(() => this.history.events(), settings);
    return tools;
  }

  /** Search when a tool is deferred, and code mode when a program has a tool
   * to call. An agent turns either off, or brings its own tool in its tools. */
  private defaultTools(own: Tool<C>[]): Record<string, Tool<C>> {
    const tools: Record<string, Tool<C>> = {};
    if (
      this.root.toolSearch !== false &&
      !own.some((definition) => definition.search) &&
      own.some((definition) => definition.deferred)
    )
      tools[SEARCH_TOOL] = defaultSearch;
    // A program cannot hand off, and has no use for search on its own.
    if (
      this.root.codeMode !== false &&
      !own.some((definition) => definition.program) &&
      own.some((definition) => !definition.handoff && !definition.search)
    )
      tools[PROGRAM_TOOL] = defaultProgram;
    return tools;
  }

  private *emit(event: ProgressEvent): Operation<void> {
    // Called as a method, so a handler can use `this`, like onApproval.
    if (this.options?.onProgress)
      yield* this.options.onProgress(structuredClone(event), this.context.context);
  }

  /** Gives the model a rejection's note, after `before` (such as the answer it
   * must revise), and reports it: only the model sees the note itself. */
  private *reject(rejection: Rejection, ...before: Message[]): Operation<void> {
    this.history.appendProvisional(...before, rejection.rejected);
    yield* this.emit(rejection.event);
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

  /** Builds the step's request and asks the model. The model gets a note instead of
   * a response when the instructions function or a `beforeStep` hook fails or
   * rejects, or when its response has a problem it can fix by trying again. */
  private *plan(messages: Message[]): Operation<ModelResponse | Rejection> {
    const {active} = this;
    let instructions: string | undefined;
    try {
      // Called as a method, so an instructions function can use `this`.
      instructions =
        typeof active.instructions === "function"
          ? yield* active.instructions(this.context)
          : active.instructions;
    } catch (error) {
      return rejection("instructions", error);
    }
    const request = {
      instructions: withSkills(instructions, this.skills?.section),
      outputSchema: this.config.outputSchema,
      maxOutputTokens: this.config.maxOutputTokens,
      step: this.step,
      messages,
      tools: this.visibleTools(),
    };
    this.lastRequest = {instructions: request.instructions, tools: request.tools};
    // The root's policy applies to every step; a handoff target adds its own.
    // A hook may send other messages in this request; the next hook sees them.
    for (const agent of new Set<AgentRuntime<C>>([this.root, this.active])) {
      if (!agent.beforeStep) continue;
      try {
        const result = yield* agent.beforeStep(request, this.context);
        const decision = guardrailDecision("beforeStep", result, "messages");
        if (decision && "reject" in decision) throw new GuardrailError(decision.reject, "denied");
        if (decision)
          request.messages = stepMessages(request.messages, decision.replace as ReadonlyMessage[]);
      } catch (error) {
        return rejection("beforeStep", error);
      }
    }
    let response: ModelResponse;
    try {
      response = modelResponse(yield* this.usage.counted(this.active.model(request)));
    } catch (error) {
      // Any other failure would recur on the next call, so it ends the run.
      if (!isResponseProblem(error)) throw error;
      return rejection("model", error);
    }
    return this.outputLimit(response.text) ?? response;
  }

  /** A note for model text longer than `maxOutputChars`, or undefined when it fits. */
  private outputLimit(text: string | undefined): Rejection | undefined {
    const max = this.config.maxOutputChars;
    if (text === undefined || text.length <= max) return undefined;
    const message = `The response has ${text.length} characters, more than the limit of ${max}. Respond more briefly.`;
    return rejection("model", new ToolError(message, "output_limit"));
  }

  /** Runs one native tool-call batch. The model cannot read a partial batch, so
   * the phase lasts until every foreground call settles; background calls were
   * acknowledged as pending and report later through collectBackground().
   * Steering does not wait for a running program: it continues in the background. */
  private *toolPhase(action: ModelToolCallsResponse): Operation<void> {
    const rejected = this.tools.rejectBatch(action, this.catalog);
    if (rejected) {
      // No call has started, so the model can send a corrected batch.
      yield* this.reject(rejection("model", new ToolError(rejected, "invalid_response")));
      return;
    }
    // Before the batch records its call: a fork must not inherit a call without its result.
    this.forkPoints.set(this.step, {
      history: this.history.branchPoint(),
      active: this.active,
      loaded: [...this.catalog.search.loaded],
    });
    const foreground = this.tools.startBatch(action, this.step, this.active, this.catalog);
    // Saved before the calls run, with the previous batch's results.
    yield* this.history.save();
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
      // Run-level tools belong to the run, not the agent, so they survive a handoff;
      // search and code mode follow the new agent's tools.
      this.catalog = createToolCatalog(this.active.tools, this.runTools());
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
      this.history.appendProvisional(answer(action), {
        role: "user",
        content: JSON.stringify({
          source: "agent-runtime",
          type: "output-invalid",
          instruction: "Return a final answer matching the requested output schema.",
        }),
      });
      return undefined;
    }
    // Text was checked with the response; structured output is checked as recorded.
    const oversized = this.outputLimit(recorded(parsed.output));
    if (oversized) {
      yield* this.reject(oversized);
      return undefined;
    }
    const outcome = yield* this.candidate(
      this.reviewAnswer({
        status: "completed",
        output: parsed.output,
        steps: this.step,
        messages: this.history.committed(),
        usage: this.usage.snapshot(),
      }),
    );
    if (outcome && "rejected" in outcome) {
      // As with an invalid answer, the model sees the answer and why it was rejected.
      yield* this.reject(outcome, answer(action));
      return undefined;
    }
    // Reasoning can contain readable details the output policy removed. Keep it
    // only when the policy leaves the answer unchanged, including structured output.
    const reasoning =
      outcome && JSON.stringify(outcome.output) === JSON.stringify(parsed.output)
        ? action.reasoning
        : undefined;
    return outcome && (yield* this.finish(outcome, reasoning));
  }

  /** Reviews a completed answer. When `afterRun` rejects it or fails in a way the
   * model receives, the model gets a note and can revise the answer. */
  private *reviewAnswer(result: RunResult<O>): Operation<RunResult<O> | Rejection> {
    try {
      return yield* this.review(result);
    } catch (error) {
      return rejection("afterRun", error);
    }
  }

  /** Returns undefined when the model should retry against the output schema. */
  private parseOutput(action: ModelFinalResponse): {output: O} | undefined {
    if (!this.output) {
      // Only a request with an output schema can fail it: the model adapter is wrong.
      if (action.validationError)
        throw new TypeError(`Unexpected output validation error: ${action.validationError}`);
      return {output: action.text as O};
    }
    let candidate: unknown = action.output;
    if (candidate === undefined) {
      try {
        candidate = JSON.parse(action.text);
      } catch {}
    }
    const parsed = this.output.safeParse(candidate);
    if (action.validationError || !parsed.success) return undefined;
    return {output: parsed.data};
  }

  /** Records and reports a steering message the root's `beforeSteering` allows, or
   * its replacement; false when the hook rejected it. Either way the run listens for
   * the next one. */
  private *acceptSteering(value: unknown): Operation<boolean> {
    const update = steeringUpdate.safeParse(typeof value === "string" ? {message: value} : value);
    if (!update.success) throw new TypeError("Steering must be a nonempty message");
    // A steering future only exists when its source does.
    this.steering = this.steeringSource!();
    const {data} = update.data;
    const withData = data === undefined ? {} : {data};
    let {message} = update.data;
    if (this.root.beforeSteering) {
      // As recorded, not the model's view: mid-batch, a call may not have its result yet.
      const request = {message, ...withData, messages: [...this.history.events()]};
      let decision: ReturnType<typeof guardrailDecision>;
      try {
        const result = yield* this.root.beforeSteering(request, this.context);
        decision = guardrailDecision("beforeSteering", result, "message");
      } catch (error) {
        // The model never sees a steering message the hook did not accept, so a
        // failure it would receive elsewhere rejects the message instead.
        if (!reachesModel(error)) throw error;
        decision = {reject: error.message};
      }
      if (decision && "reject" in decision) {
        yield* this.emit({type: "steering-rejected", reason: decision.reject, ...withData});
        return false;
      }
      if (decision) {
        if (typeof decision.replace !== "string" || !decision.replace.trim())
          throw new TypeError("beforeSteering must return a nonempty message");
        message = decision.replace;
      }
    }
    this.history.appendSteering(message);
    // Saved before the event, so a reader that gets the event finds the note.
    // During a batch, the note must follow the batch's results, so the next save
    // stores it after them.
    if (!this.tools.inBatch) yield* this.history.save();
    yield* this.emit({type: "steering", message, ...withData});
    return true;
  }

  private *review(result: RunResult<O>): Operation<RunResult<O>> {
    const finalize = this.root.finalize ?? this.root.model;
    if (finalize && result.status !== "completed") {
      yield* this.compactContext();
      const counted = this.usage.count(finalize);
      const context = this.history.finalContext();
      result = yield* summarizeStoppedRun(result, counted, context, this.config.maxOutputChars);
    }
    // Compaction and the summary add usage; the policy and the caller see it.
    result = {...result, usage: this.usage.snapshot()};
    // A fork's answer is a tool result of the parent run, not the run's output.
    if (this.root.afterRun && !this.origin) {
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
      usage: this.usage.snapshot(),
    };
    let result: RunResult<O>;
    if (cause instanceof RunInterrupted)
      result = {...end, status: "interrupted", reason: cause.message};
    else if (cause) result = {...end, status: "stopped", reason: "max_tool_calls"};
    else result = {...end, status: "stopped", reason: "max_steps"};
    return yield* this.finish(yield* this.review(result));
  }

  /** Records the history of a run that `error` ends, for `messagesOf`, and saves it
   * when the error fails the invocation, so the next run knows what happened.
   * Running work stops first: calls that never finished get cancelled results, and
   * a note tells the model why the run ended. A retryable error saves nothing:
   * Restate retries the invocation, and a journaled save would not match a retry
   * that takes another path. A conflict means another writer changed the
   * conversation, so saving again would fail the same way. A failure to save is
   * logged; the caller still receives the run's own error.
   *
   * A run that fails before `beforeRun` accepted its input records nothing:
   * throwing `AgentTerminalError` from `beforeRun` keeps the input out of the
   * history. */
  private *fail(error: unknown): Operation<void> {
    if (!this.inputChecked) return;
    try {
      yield* this.tasks.close();
      const reason = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof CancelledError;
      const closed = `${cancelled ? "Run cancelled" : "Run failed"}: ${reason}`;
      this.tools.commitBatch(closed);
      this.history.append(...this.tools.settlePending(new InterruptedError(closed)));
      this.history.append({
        role: "user",
        content: JSON.stringify({
          source: "agent-runtime",
          type: cancelled ? "run-cancelled" : "run-failed",
          message: reason,
        }),
      });
      recordFailedHistory(error, this.history.committed());
      if (error instanceof TerminalError && !(error instanceof ConversationConflictError))
        yield* this.history.save();
    } catch (failure) {
      logger().warn("Could not record the failed run's history:", failure);
    }
  }

  /** The schema the run's answer must match. A fork answers in plain text: its
   * reply is a tool result for the parent, not the run's output. */
  private get output(): AgentOptions<C, O>["output"] {
    return this.origin ? undefined : this.root.output;
  }

  /** Runs a copy of this run on `task`, from the fork point of the call's step.
   * The fork has its own steps, tool budget, and history, and saves nothing.
   * Its usage counts toward this run; its approval requests reach this run's
   * handlers, and its progress arrives as progress of the call. Interrupting
   * the call interrupts the fork. */
  private *fork(task: string, call: ToolContext<C>, limits: ForkLimits): Operation<RunResult<O>> {
    const point = this.forkPoints.get(call.step);
    if (!point) throw new ToolError("No model step to fork from", "fork_unavailable");
    // Checked and counted with no yield in between, so concurrent calls see each other.
    const running = this.runningForks.get(limits) ?? 0;
    if (running >= limits.maxConcurrent)
      throw new ToolError(
        `At most ${limits.maxConcurrent} forks of ${call.toolName} can run at once. ` +
          "Fork again after one finishes, or do this work yourself.",
        "fork_limit",
      );
    this.runningForks.set(limits, running + 1);
    const usage = new RunUsageTracker();
    try {
      const options = {
        context: this.options?.context,
        tools: this.options?.tools,
        // A run name unique to this call keeps approval signals of concurrent forks apart.
        name: `${call.name}/${call.callId}`,
        // The fork has this run's policies, which publish approval requests themselves.
        onApproval: this.options?.onApproval?.bind(this.options),
        // Forwarded unchecked: the fork's own limits bound its events.
        onProgress: forwardProgress(call as ToolContext<unknown>),
      } as RunOptions<C>;
      const history = this.history.branch(point.history, FORK_PREAMBLE + task);
      const origin = {active: point.active, skills: this.skills, loaded: point.loaded};
      // Without the output schema, the fork's requests ask for a plain reply.
      const config = {...this.config, outputSchema: undefined};
      return yield* new AgentRun<C, O>(this.root, config, history, usage, options, origin).run();
    } catch (error) {
      recordFailedRun(error, usage.snapshot());
      throw error;
    } finally {
      this.runningForks.set(limits, this.runningForks.get(limits)! - 1);
      this.usage.add(usage.snapshot());
    }
  }

  /** Validates the accepted result, commits its output, and saves the turn. The
   * model's answers and summaries were checked already, so a check that fails here
   * found a mistake in `afterRun`: a plain error, which Restate retries, so the
   * invocation can continue once a fix is deployed. */
  private *finish(result: RunResult<O>, reasoning?: Reasoning): Operation<RunResult<O>> {
    if (result.status === "completed") {
      if (this.output) {
        const parsed = this.output.safeParse(result.output);
        if (!parsed.success)
          throw new TypeError(
            `Run output does not match the output schema: ${parsed.error.message}`,
          );
        result = {...result, output: parsed.data};
      } else if (typeof result.output !== "string")
        throw new TypeError("A completed text run must have a string output");
    }
    const content = result.output === undefined ? undefined : recorded(finalOutput(result.output));
    if (content !== undefined && content.length > this.config.maxOutputChars)
      throw new RangeError("Final output exceeds maxOutputChars");
    // Only accepted output reaches history: a discarded candidate never does,
    // and a policy-provided stopped summary gets its own message.
    if (content !== undefined) {
      this.history.append({
        role: "assistant",
        content,
        ...(reasoning ? {reasoning: structuredClone(reasoning)} : {}),
      });
    }
    yield* this.history.save();
    return {...result, messages: this.history.committed()};
  }
}

function finalOutput(value: unknown) {
  const parsed = jsonSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Run output must be JSON");
  return parsed.data;
}
