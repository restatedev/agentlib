import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Conversation} from "./conversation.js";
import type {Message} from "./types.js";
import {history} from "./validation.js";

/** Run-local history owns the persistence cursor, including compaction reloads. */
export function* loadRunHistory(
  input: string,
  source: {conversation?: Conversation; messages?: readonly Message[]} = {},
) {
  if (typeof input !== "string" || !input.trim())
    throw new TypeError("Agent input must be a nonempty string");
  const {conversation} = source;
  if (conversation && source.messages) throw new TypeError("Use either conversation or messages");
  const snapshot = conversation ? yield* conversation.load() : undefined;
  let version = snapshot?.version ?? 0;
  const messages = history(snapshot?.messages ?? source.messages ?? []);
  let persisted = messages.length;
  messages.push({role: "user", content: input});

  return {
    messages,
    *save(): Operation<void> {
      if (conversation && messages.length > persisted) {
        version = yield* conversation.append(messages.slice(persisted), version);
        persisted = messages.length;
      }
    },
    *compact(): Operation<void> {
      if (!conversation?.compact) return;
      yield* conversation.compact();
      const compacted = yield* conversation.load();
      messages.splice(0, messages.length, ...history(compacted.messages), {
        role: "user",
        content: input,
      });
      persisted = compacted.messages.length;
      version = compacted.version;
    },
  };
}
