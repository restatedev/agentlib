import {allSettled, InterruptedError, spawn, type Operation} from "@restatedev/restate-sdk-gen";
import {AgentLimitError} from "./errors.js";
import {createMailbox} from "./mailbox.js";
import type {AgentStream, AgentUpdate, RunResult} from "./types.js";

const MAX_BUFFERED_UPDATES = 4096;

/** One consumer; closing always interrupts and joins the producer's cleanup. */
export function* streamRun<O>(
  run: (emit: (event: AgentUpdate) => Operation<void>) => Operation<RunResult<O>>,
): Operation<AgentStream<O>> {
  const updates = createMailbox<AgentUpdate>();
  const result = spawn(
    (function* () {
      try {
        return yield* run(function* (event) {
          if (updates.size >= MAX_BUFFERED_UPDATES)
            throw new AgentLimitError("Stream buffer full; consume next() while running");
          yield* updates.push(event);
        });
      } finally {
        yield* updates.close();
      }
    })(),
  );
  return {
    result,
    *next() {
      const next = yield* updates.next();
      // Preserve producer failures after delivering its buffered updates.
      if (next.done) yield* result;
      return next;
    },
    *close() {
      result.interrupt(new InterruptedError("Agent stream closed"));
      yield* allSettled([result]);
    },
  };
}
