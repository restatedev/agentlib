import {channel as oneshot, type Operation} from "@restatedev/restate-sdk-gen";

/** Run-local FIFO with one consumer. Read `ready` again after consuming messages.
 * Each empty-to-nonempty transition settles a fresh one-shot wakeup. Closing
 * wakes a parked consumer and lets it drain buffered messages before finishing. */
export function createMailbox<T>() {
  const queue: T[] = [];
  let wakeup = oneshot<void>();
  let closed = false;

  function rearm() {
    if (!queue.length && !closed) wakeup = oneshot<void>();
  }

  return {
    get size() {
      return queue.length;
    },
    get ready() {
      return wakeup.receive;
    },
    *push(value: T): Operation<void> {
      if (closed) throw new Error("Cannot push to a closed mailbox");
      queue.push(value);
      if (queue.length === 1) yield* wakeup.send();
    },
    drain(): T[] {
      const values = queue.splice(0);
      rearm();
      return values;
    },
    *next(): Operation<IteratorResult<T>> {
      while (!queue.length && !closed) yield* wakeup.receive;
      if (!queue.length) return {done: true, value: undefined};
      const value = queue.shift()!;
      rearm();
      return {done: false, value};
    },
    *close(): Operation<void> {
      if (closed) return;
      closed = true;
      if (!queue.length) yield* wakeup.send();
    },
  };
}
