import {
  allSettled,
  channel,
  InterruptedError,
  spawn,
  type Operation,
} from "@restatedev/restate-sdk-gen";
import {AgentLimitError} from "./errors.js";
import type {AgentStream, AgentUpdate, RunResult} from "./types.js";

const MAX_BUFFERED_UPDATES = 4096;

/** One consumer; closing always interrupts and joins the producer's cleanup. */
export function* streamRun<O>(
  run: (emit: (event: AgentUpdate) => Operation<void>) => Operation<RunResult<O>>,
): Operation<AgentStream<O>> {
  const queue: AgentUpdate[] = [];
  let ready = channel<void>();
  let done = false;
  const result = spawn(
    (function* () {
      try {
        return yield* run(function* (event) {
          if (queue.length >= MAX_BUFFERED_UPDATES)
            throw new AgentLimitError("Stream buffer full; consume next() while running");
          queue.push(event);
          yield* ready.send();
        });
      } finally {
        done = true;
        yield* ready.send();
      }
    })(),
  );
  return {
    result,
    *next() {
      while (!queue.length && !done) yield* ready.receive;
      const value = queue.shift();
      if (!queue.length) ready = channel<void>();
      if (value) return {done: false, value};
      yield* result;
      return {done: true, value: undefined};
    },
    *close() {
      result.interrupt(new InterruptedError("Agent stream closed"));
      yield* allSettled([result]);
    },
  };
}
