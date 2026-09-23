import {type InterruptedError, type Operation, type Task} from "@restatedev/restate-sdk-gen";
import {ModelProtocolError, ToolCancelled, ToolError} from "./errors.js";
import {createToolExecutor, type ToolExecutionLimits, type ToolExecutor} from "./tool-executor.js";
import type {ToolCatalog} from "./tool-catalog.js";
import type {RunHistory} from "./run-history.js";
import type {FutureBranches, RunTasks} from "./run-tasks.js";
import type {
  AgentRuntime,
  ApprovalHandler,
  Message,
  ModelToolCallsResponse,
  RunContext,
  ToolCall,
  ToolResult,
} from "./types.js";

type Outcome = {result?: ToolResult};
type Completion = Readonly<{call: ToolCall; result: ToolResult}>;
type Entry = Readonly<{
  call: ToolCall;
  background: boolean;
  task: Task<ToolResult>;
  outcome: Outcome;
}>;
type Batch<C> = {
  entries: readonly Entry[];
  transfer?: ToolCall;
  catalog: ToolCatalog<C>;
  reported: Set<string>;
};

/** Owns call IDs and the active batch. Background tasks stay addressable by ID
 * for cancellation; completed results wait in a FIFO queue for the turn loop.
 * Task lifetime belongs to RunTasks; transcript changes go through RunHistory. */
export class RunTools<C> {
  private readonly usedIds: Set<string>;
  private readonly backgroundById = new Map<string, Entry>();
  private readonly completed: Completion[] = [];
  private batch: Batch<C> | undefined;
  private readonly executor: ToolExecutor<C>;

  constructor(
    root: AgentRuntime<C>,
    context: RunContext<C>,
    limits: ToolExecutionLimits,
    private readonly tasks: RunTasks,
    private readonly history: RunHistory,
    onApproval?: ApprovalHandler<C>,
  ) {
    const previousCallIds = history.snapshot().flatMap((message) => {
      if (message.role !== "assistant") return [];
      return (message.calls ?? []).map((call) => call.id);
    });
    this.usedIds = new Set(previousCallIds);
    this.executor = createToolExecutor({
      root,
      context,
      ...limits,
      onApproval,
      cancelOperation: (id, reason) => this.cancel(id, reason),
    });
  }

  get hasPending(): boolean {
    return this.backgroundById.size > 0;
  }

  pendingTasks(): FutureBranches {
    return Object.fromEntries(
      [...this.backgroundById].map(([id, entry]) => [`pending:${id}`, entry.task]),
    );
  }

  startBatch(
    action: ModelToolCallsResponse,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): FutureBranches {
    const transfers = action.calls.filter((call) => catalog.registry.get(call.name)?.handoff);
    if (transfers.length > 1) throw new ModelProtocolError("Only one handoff is allowed per batch");
    this.executor.assertCapacity(action.calls.length);
    for (const call of action.calls) {
      if (this.usedIds.has(call.id))
        throw new ModelProtocolError(`Duplicate tool-call ID: ${call.id}`);
      this.usedIds.add(call.id);
    }
    this.history.append({
      role: "assistant",
      content: action.text ?? "",
      calls: structuredClone(action.calls),
    });
    const entries = action.calls.map((call) => this.start(call, step, owner, catalog));
    this.batch = {
      entries,
      transfer: transfers[0],
      catalog,
      reported: new Set(),
    };
    const foreground: FutureBranches = {};
    for (const entry of entries) {
      if (entry.background) {
        this.backgroundById.set(entry.call.id, entry);
        this.record(entry, {status: "pending", operationId: entry.call.id});
      } else {
        foreground[`tool:${entry.call.id}`] = entry.task;
      }
    }
    return foreground;
  }

  /** Record a foreground result as soon as its task completes. */
  recordResult(id: string, result: ToolResult): void {
    const entry = this.batch?.entries.find((candidate) => candidate.call.id === id);
    if (!entry || entry.background)
      throw new Error(`No foreground call in the active batch: ${id}`);
    this.record(entry, result);
  }

  /** Returns an approved transfer without activating it before results are flushed. */
  commitBatch(reason?: string): (() => AgentRuntime<C>) | undefined {
    if (!this.batch) return undefined;
    const {entries, transfer, catalog, reported} = this.batch;
    const transferred =
      transfer &&
      entries.find((entry) => entry.call.id === transfer.id)?.outcome.result?.status === "success";
    for (const entry of entries) {
      if (reported.has(entry.call.id)) continue;
      const result = entry.outcome.result ?? {
        status: "cancelled",
        message: reason ?? "Run stopped",
      };
      this.record(entry, result);
    }
    this.batch = undefined;
    if (!transferred) return undefined;
    const definition = catalog.registry.get(transfer.name)!;
    return () => definition.handoff!();
  }

  /** Drain background completions in the order their tasks finished. */
  drainCompleted(): Message[] {
    return this.completed.splice(0).map(({call, result}) => {
      this.backgroundById.delete(call.id);
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
    for (const entry of this.backgroundById.values()) {
      if (entry.outcome.result) continue;
      const result: ToolResult = {status: "cancelled", message: reason.message};
      entry.outcome.result = result;
      this.completed.push({call: entry.call, result});
    }
    return this.drainCompleted();
  }

  private start(
    call: ToolCall,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): Entry {
    const outcome: Outcome = {};
    const background = catalog.registry.get(call.name)?.background ?? false;
    return {
      call,
      background,
      outcome,
      // The task publishes its result through a per-call outcome. Its launching
      // agent, catalog, and step stay fixed even if the run later hands off.
      task: this.tasks.spawn(this.invoke(call, step, owner, catalog, outcome, background)),
    };
  }

  private *invoke(
    call: ToolCall,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
    outcome: Outcome,
    background: boolean,
  ): Operation<ToolResult> {
    const result = yield* this.executor.execute(call, step, owner, catalog);
    outcome.result = result;
    if (background) this.completed.push({call, result});
    return result;
  }

  private *cancel(id: string, reason = "Cancelled by the agent"): Operation<boolean> {
    const entry = this.backgroundById.get(id);
    if (!entry) throw new ToolError(`Unknown pending operation: ${id}`, "unknown_operation");
    if (entry.outcome.result) return false;
    entry.task.interrupt(new ToolCancelled(reason));
    return (yield* entry.task).status === "cancelled";
  }

  private record(entry: Entry, result: ToolResult): void {
    const batch = this.batch!;
    this.history.append({
      role: "tool",
      callId: entry.call.id,
      name: entry.call.name,
      result,
    });
    batch.reported.add(entry.call.id);
  }
}
