import {
  allSettled,
  channel as oneshot,
  InterruptedError,
  select,
  spawn,
  type Future,
  type Operation,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {RunInterrupted} from "./errors.js";

/** Owns child tasks, their first fatal failure, and the interruption cutoff. */
export class RunTasks {
  private readonly owned = new Set<Task<unknown>>();
  private readonly fatal = oneshot<void>();
  private failure: {error: unknown} | undefined;
  private finalizing = false;

  track<T>(operation: Operation<T>): Task<T> {
    const task = spawn(this.captureFailure(operation));
    this.owned.add(task);
    return task;
  }

  beginFinalization(): void {
    this.finalizing = true;
  }

  *supervise<T>(operation: Operation<T>, interrupt?: Future<string>): Operation<T> {
    const driver = spawn(operation);
    try {
      const branches: Record<string, Future<unknown>> = {
        fatal: this.fatal.receive,
        ...(interrupt ? {interrupt} : {}),
        driver,
      };
      const selected = yield* select(branches);
      if (selected.tag === "fatal") {
        driver.interrupt(this.failure!.error);
        yield* allSettled([driver]);
        throw this.failure!.error;
      }
      if (selected.tag === "interrupt") {
        const reason = yield* selected.future;
        if (typeof reason !== "string") throw new TypeError("Interruption reason must be a string");
        if (!this.finalizing) driver.interrupt(new RunInterrupted(reason));
      }
      return yield* driver;
    } catch (error) {
      driver.interrupt(error);
      yield* allSettled([driver]);
      throw error;
    }
  }

  *stop(reason: InterruptedError): Operation<void> {
    const results = yield* this.settle(reason);
    const failed = results.find(
      (result) => result.status === "rejected" && !(result.reason instanceof InterruptedError),
    );
    if (failed?.status === "rejected") throw failed.reason;
  }

  *close(): Operation<void> {
    yield* this.settle(new InterruptedError("Agent run finished"));
  }

  private *settle(reason: InterruptedError) {
    for (const task of this.owned) task.interrupt(reason);
    return yield* allSettled([...this.owned]);
  }

  private *captureFailure<T>(operation: Operation<T>): Operation<T> {
    try {
      return yield* operation;
    } catch (error) {
      // Wake supervision even when the driver is parked on an unrelated task.
      if (!(error instanceof InterruptedError)) {
        this.failure ??= {error};
        yield* this.fatal.send();
      }
      throw error;
    }
  }
}
