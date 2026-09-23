import {
  allSettled,
  channel as oneshot,
  InterruptedError,
  spawn,
  type Future,
  type Operation,
  type Task,
} from "@restatedev/restate-sdk-gen";

export type FutureBranches = Record<string, Future<unknown>>;

/** Owns child task cleanup and reports the first unexpected failure. */
export class RunTasks {
  private readonly owned = new Set<Task<unknown>>();
  private readonly failure = oneshot<unknown>();
  readonly failed = this.failure.receive;

  spawn<T>(operation: Operation<T>): Task<T> {
    let task: Task<T>;
    task = spawn(this.captureFailure(operation, () => this.owned.delete(task)));
    this.owned.add(task);
    return task;
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
    const tasks = [...this.owned];
    for (const task of tasks) task.interrupt(reason);
    return yield* allSettled(tasks);
  }

  private *captureFailure<T>(operation: Operation<T>, release: () => void): Operation<T> {
    let unexpectedFailure = false;
    try {
      return yield* operation;
    } catch (error) {
      // A failed background task must wake the run even while other work is parked.
      unexpectedFailure = !(error instanceof InterruptedError);
      if (unexpectedFailure) yield* this.failure.send(error);
      throw error;
    } finally {
      // Keep unexpected failures until stop() has had a chance to report them.
      if (!unexpectedFailure) release();
    }
  }
}
