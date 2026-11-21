import {type InterruptedError, type Operation, type Task} from "@restatedev/restate-sdk-gen";
import {ToolCancelled, ToolError} from "./errors.js";
import {createToolExecutor, type ToolExecutionLimits, type ToolExecutor} from "./tool-executor.js";
import type {ToolCatalog} from "./tool-catalog.js";
import type {RunHistory} from "./run-history.js";
import type {FutureBranches, RunTasks} from "./run-tasks.js";
import type {
  AgentRuntime,
  ApprovalHandler,
  Message,
  ModelCutOffResponse,
  ModelToolCallsResponse,
  ProgressEvent,
  RunContext,
  ToolCall,
  ToolResult,
} from "./types.js";

type Entry = {
  readonly call: ToolCall;
  readonly program: boolean;
  /** Set for background calls, and for a program once steering hands it off. */
  background: boolean;
  task?: Task<ToolResult>;
  result?: ToolResult;
};
type Batch<C> = {
  foreground: Entry[];
  handoff?: {id: string; target: () => AgentRuntime<C>};
};

/** Owns call IDs and the active batch. Foreground results are recorded as their
 * tasks finish; background results wait in a FIFO queue for the turn loop.
 * Task lifetime belongs to RunTasks; transcript changes go through RunHistory. */
export class RunTools<C> {
  private readonly usedIds: Set<string>;
  private readonly background = new Map<string, Entry>();
  private readonly completed: Entry[] = [];
  private batch: Batch<C> | undefined;
  private readonly executor: ToolExecutor<C>;

  constructor(
    root: AgentRuntime<C>,
    context: RunContext<C>,
    limits: ToolExecutionLimits,
    private readonly tasks: RunTasks,
    private readonly history: RunHistory,
    progress: (event: ProgressEvent) => Operation<void>,
    onApproval?: ApprovalHandler<C>,
  ) {
    this.usedIds = new Set(
      history
        .snapshot()
        .flatMap((message) => (message.role === "assistant" ? (message.calls ?? []) : []))
        .map((call) => call.id),
    );
    this.executor = createToolExecutor({
      root,
      context,
      ...limits,
      onApproval,
      progress,
      cancelOperation: (id, reason) => this.cancel(id, reason),
    });
  }

  get hasPending(): boolean {
    return this.background.size > 0;
  }

  /** True from `startBatch` until `commitBatch`. */
  get inBatch(): boolean {
    return this.batch !== undefined;
  }

  /** Background calls whose results the model has not seen yet. */
  pendingCalls(): {operationId: string; name: string}[] {
    return [...this.background.values()].map(({call}) => ({operationId: call.id, name: call.name}));
  }

  pendingTasks(): FutureBranches {
    return Object.fromEntries(
      [...this.background].map(([id, entry]) => [`pending:${id}`, entry.task!]),
    );
  }

  /** Why a batch cannot run, or undefined when it can. Changes nothing, so the
   * model can send a corrected batch, even with the same call IDs. */
  rejectBatch(action: ModelToolCallsResponse, catalog: ToolCatalog<C>): string | undefined {
    if (handoffs(action, catalog).length > 1) return "Only one handoff is allowed per batch";
    const ids = new Set<string>();
    for (const {id} of action.calls) {
      if (this.usedIds.has(id) || ids.has(id)) return `Duplicate tool-call ID: ${id}`;
      ids.add(id);
    }
    return undefined;
  }

  /** Starts a batch `rejectBatch` accepted. Returns its foreground tasks; each
   * records its own result when it finishes. Background calls are acknowledged now. */
  startBatch(
    action: ModelToolCallsResponse,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): FutureBranches {
    const transfers = handoffs(action, catalog);
    this.executor.assertCapacity(action.calls.length);
    for (const call of action.calls) this.usedIds.add(call.id);
    this.history.append({
      role: "assistant",
      content: action.text ?? "",
      calls: structuredClone(action.calls),
      ...(action.reasoning ? {reasoning: structuredClone(action.reasoning)} : {}),
    });

    const batch: Batch<C> = {foreground: []};
    const [transfer] = transfers;
    if (transfer)
      batch.handoff = {id: transfer.id, target: catalog.registry.get(transfer.name)!.handoff!};
    this.batch = batch;

    const tasks: FutureBranches = {};
    for (const call of action.calls) {
      const definition = catalog.registry.get(call.name);
      const entry: Entry = {
        call,
        program: !call.validationError && (definition?.program ?? false),
        background: !call.validationError && (definition?.background ?? false),
      };
      // The launching agent, catalog, and step stay fixed even if the run later hands off.
      entry.task = this.tasks.spawn(this.invoke(entry, step, owner, catalog));
      if (entry.background) {
        this.background.set(call.id, entry);
        this.record(call, {status: "pending", operationId: call.id});
      } else {
        batch.foreground.push(entry);
        tasks[`tool:${call.id}`] = entry.task;
      }
    }
    return tasks;
  }

  /** Records a reply cut off at the output token limit, marked `cutOff`. Its calls
   * never run: each gets a failed result, so the history stays valid. A call that
   * reuses an earlier call's ID is left out, and so is a reply with nothing in it.
   * Text over `maxChars` is clipped, without the signed text parts a provider
   * would reject once changed. */
  recordCutOff(reply: ModelCutOffResponse, maxChars: number): void {
    const calls: ToolCall[] = [];
    for (const call of reply.calls ?? []) {
      if (this.usedIds.has(call.id)) continue;
      this.usedIds.add(call.id);
      calls.push(structuredClone(call));
    }
    let {text} = reply;
    const reasoning = reply.reasoning && structuredClone(reply.reasoning);
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      delete reasoning?.text;
    }
    if (!text.trim() && !reasoning && !calls.length) return;
    this.history.append({
      role: "assistant",
      content: text,
      ...(calls.length ? {calls} : {}),
      ...(reasoning ? {reasoning} : {}),
      cutOff: true,
    });
    for (const call of calls)
      this.record(call, {
        status: "error",
        code: "cut_off",
        message: "Not run: the reply was cut off at the output token limit",
      });
  }

  /** Moves the batch's still-running programs to background work, so steering
   * reaches the model without waiting for them. Each gets a pending result now
   * and reports like any background call. Returns their foreground task names. */
  handOffPrograms(): string[] {
    const batch = this.batch;
    if (!batch) return [];
    const running = batch.foreground.filter((entry) => entry.program && !entry.result);
    for (const entry of running) {
      entry.background = true;
      this.background.set(entry.call.id, entry);
      this.record(entry.call, {status: "pending", operationId: entry.call.id});
    }
    batch.foreground = batch.foreground.filter((entry) => !running.includes(entry));
    return running.map((entry) => `tool:${entry.call.id}`);
  }

  /** Closes the batch, cancelling calls that never produced a result. Returns
   * the handoff target when the batch approved one; the caller activates it. */
  commitBatch(reason = "Run stopped"): (() => AgentRuntime<C>) | undefined {
    const batch = this.batch;
    if (!batch) return undefined;
    this.batch = undefined;
    for (const entry of batch.foreground) {
      if (!entry.result) this.record(entry.call, {status: "cancelled", message: reason});
    }
    const {handoff} = batch;
    if (!handoff) return undefined;
    const approved = batch.foreground.find((entry) => entry.call.id === handoff.id);
    return approved?.result?.status === "success" ? handoff.target : undefined;
  }

  /** Drain background completions in the order their tasks finished. */
  drainCompleted(): Message[] {
    return this.completed.splice(0).map(({call, result}) => {
      this.background.delete(call.id);
      return {
        role: "user",
        content: JSON.stringify({
          source: "agent-runtime",
          type: "background-tool-result",
          operationId: call.id,
          name: call.name,
          result,
        }),
      };
    });
  }

  settlePending(reason: InterruptedError): Message[] {
    // Work interrupted before its first execute yield still needs a result.
    for (const entry of this.background.values()) {
      if (entry.result) continue;
      entry.result = {status: "cancelled", message: reason.message};
      this.completed.push(entry);
    }
    return this.drainCompleted();
  }

  private *invoke(
    entry: Entry,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): Operation<ToolResult> {
    const result = yield* this.executor.execute(entry.call, step, owner, catalog);
    entry.result = result;
    if (entry.background) this.completed.push(entry);
    else this.record(entry.call, result);
    return result;
  }

  private *cancel(id: string, reason = "Cancelled by the agent"): Operation<boolean> {
    const entry = this.background.get(id);
    if (!entry) throw new ToolError(`Unknown pending operation: ${id}`, "unknown_operation");
    if (entry.result) return false;
    entry.task!.interrupt(new ToolCancelled(reason));
    return (yield* entry.task!).status === "cancelled";
  }

  private record(call: ToolCall, result: ToolResult): void {
    this.history.append({role: "tool", callId: call.id, name: call.name, result});
  }
}

/** The calls in a batch that hand off to another agent. */
function handoffs<C>(action: ModelToolCallsResponse, catalog: ToolCatalog<C>): ToolCall[] {
  return action.calls.filter(
    (call) => !call.validationError && catalog.registry.get(call.name)?.handoff,
  );
}
