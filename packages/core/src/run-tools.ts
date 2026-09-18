import type {Future, InterruptedError, Operation, Task} from "@restatedev/restate-sdk-gen";
import {ModelProtocolError, ToolCancelled, ToolError} from "./errors.js";
import {createToolExecutor, type ToolExecutionLimits, type ToolExecutor} from "./tool-executor.js";
import type {ToolCatalog} from "./tool-catalog.js";
import type {RunHistory} from "./run-history.js";
import type {FutureBranches, RunTasks} from "./run-tasks.js";
import type {RunUpdates} from "./run-updates.js";
import type {
  AgentRuntime,
  Message,
  ModelToolCallsResponse,
  RunContext,
  ToolCall,
  ToolResult,
} from "./types.js";

type Outcome = {result?: ToolResult};
type ForegroundTasks = Map<string, Future<unknown>>;
type Entry = Readonly<{
  call: ToolCall;
  background: boolean;
  task: Task<ToolResult>;
  outcome: Outcome;
}>;
type Batch<C> = Readonly<{entries: readonly Entry[]; transfer?: ToolCall; catalog: ToolCatalog<C>}>;

/** Owns call IDs, the active batch, and pending background results. Task lifetime
 * belongs to RunTasks; transcript changes go through RunHistory. */
export class RunTools<C> {
  private readonly usedIds: Set<string>;
  private readonly pending = new Map<string, Entry>();
  private batch: Batch<C> | undefined;
  private readonly executor: ToolExecutor<C>;

  constructor(
    root: AgentRuntime<C>,
    context: RunContext<C>,
    limits: ToolExecutionLimits,
    private readonly tasks: RunTasks,
    private readonly history: RunHistory,
    private readonly updates: RunUpdates<C>,
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
      update: (event) => updates.emit(event),
      cancelOperation: (id, reason) => this.cancel(id, reason),
    });
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingTasks(): FutureBranches {
    return Object.fromEntries(
      [...this.pending].map(([id, entry]) => [`pending:${id}`, entry.task]),
    );
  }

  *startBatch(
    action: ModelToolCallsResponse,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): Operation<ForegroundTasks> {
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
    this.batch = {entries, transfer: transfers[0], catalog};
    const foreground: ForegroundTasks = new Map();
    for (const entry of entries) {
      if (entry.background) this.pending.set(entry.call.id, entry);
      else foreground.set(`tool:${entry.call.id}`, entry.task);
    }
    for (const entry of entries)
      if (this.pending.has(entry.call.id))
        yield* this.updates.emit({
          type: "tool-pending",
          step,
          call: entry.call,
          operationId: entry.call.id,
        });
    return foreground;
  }

  /** Returns an approved transfer without activating it before results are flushed. */
  commitBatch(reason?: string): (() => AgentRuntime<C>) | undefined {
    if (!this.batch) return undefined;
    const {entries, transfer, catalog} = this.batch;
    const transferred =
      transfer &&
      entries.find((entry) => entry.call.id === transfer.id)?.outcome.result?.status === "success";
    const messages: Message[] = [];
    for (const entry of entries) {
      let result = entry.outcome.result;
      if (entry.background) {
        result = {status: "pending", operationId: entry.call.id};
      } else if (!result) {
        result = {status: "cancelled", message: reason ?? "Run stopped"};
      }
      messages.push({
        role: "tool",
        callId: entry.call.id,
        name: entry.call.name,
        result,
      });
    }
    this.history.append(...messages);
    this.batch = undefined;
    if (!transferred) return undefined;
    const definition = catalog.registry.get(transfer.name)!;
    return () => definition.handoff!();
  }

  collectResults(): void {
    for (const [id, entry] of this.pending) {
      if (!entry.outcome.result) continue;
      this.pending.delete(id);
      this.history.observe({
        type: "background-tool-result",
        operationId: id,
        name: entry.call.name,
        result: entry.outcome.result,
      });
    }
  }

  settlePending(reason: InterruptedError): void {
    // Work interrupted before its first execute yield still needs an observation.
    for (const entry of this.pending.values())
      entry.outcome.result ??= {status: "cancelled", message: reason.message};
    this.collectResults();
  }

  private start(
    call: ToolCall,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
  ): Entry {
    const outcome: Outcome = {};
    return {
      call,
      background: catalog.registry.get(call.name)?.background ?? false,
      outcome,
      // The task publishes its result through a per-call outcome. Its launching
      // agent, catalog, and step stay fixed even if the run later hands off.
      task: this.tasks.track(this.invoke(call, step, owner, catalog, outcome)),
    };
  }

  private *invoke(
    call: ToolCall,
    step: number,
    owner: AgentRuntime<C>,
    catalog: ToolCatalog<C>,
    outcome: Outcome,
  ): Operation<ToolResult> {
    yield* this.updates.emit({
      type: "tool-start",
      step,
      call,
      info: {name: call.name, details: call.input},
    });
    const result = yield* this.executor.execute(call, step, owner, catalog);
    yield* this.updates.emit({type: "tool-end", step, call, result});
    outcome.result = result;
    return result;
  }

  private *cancel(id: string, reason = "Cancelled by the agent"): Operation<boolean> {
    const entry = this.pending.get(id);
    if (!entry) throw new ToolError(`Unknown pending operation: ${id}`, "unknown_operation");
    if (entry.outcome.result) return false;
    entry.task.interrupt(new ToolCancelled(reason));
    return (yield* entry.task).status === "cancelled";
  }
}
