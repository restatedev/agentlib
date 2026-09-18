import {
  allSettled,
  type Future,
  type InterruptedError,
  type Operation,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {createMailbox} from "./mailbox.js";
import type {RunHistory} from "./run-history.js";
import type {RunTasks} from "./run-tasks.js";
import type {AgentEvent, RunContext, UpdateHandler} from "./types.js";

/** Owns update sequencing and the steering watcher; history owns observations. */
export class RunUpdates<C> {
  private sequence = 0;
  private readonly steering = createMailbox<string>();
  private watcher: Task<void> | undefined;

  constructor(
    private readonly context: RunContext<C>,
    private readonly history: RunHistory,
    private readonly definitionHook?: UpdateHandler<C>,
    private readonly runHook?: UpdateHandler<C>,
  ) {}

  *emit(event: AgentEvent): Operation<void> {
    const sequence = ++this.sequence;
    const value = {
      ...event,
      sequence,
      id: `${this.context.invocationId}:${this.context.name}:${sequence}`,
    };
    if (this.definitionHook)
      yield* this.definitionHook(structuredClone(value), this.context.context);
    if (this.runHook) yield* this.runHook(structuredClone(value), this.context.context);
  }

  startSteering(tasks: RunTasks, source?: () => Future<string>): void {
    if (source) this.watcher = tasks.track(this.watch(source));
  }

  get steeringReady(): Future<void> | undefined {
    return this.watcher ? this.steering.ready : undefined;
  }

  get hasSteering(): boolean {
    return this.steering.size > 0;
  }

  *drainSteering(step: number): Operation<void> {
    for (const message of this.steering.drain()) {
      this.history.observe({type: "steering", message});
      yield* this.emit({type: "steering", step, message});
    }
  }

  *stopSteering(reason?: InterruptedError): Operation<void> {
    this.watcher?.interrupt(reason);
    if (this.watcher) yield* allSettled([this.watcher]);
  }

  private *watch(source: () => Future<string>): Operation<void> {
    while (true) {
      const message = yield* source();
      if (typeof message !== "string" || !message.trim())
        throw new TypeError("Steering must be a nonempty string");
      yield* this.steering.push(message);
    }
  }
}
