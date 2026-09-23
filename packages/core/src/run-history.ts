import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Conversation} from "./conversation.js";
import type {Message} from "./types.js";
import {history} from "./validation.js";

type HistorySource = {conversation?: Conversation; messages?: readonly Message[]};
type ToolMessage = Extract<Message, {role: "tool"}>;

/** Events arrive in execution order. Model protocols require each batch's tool
 * results immediately after its assistant call, ahead of intervening steering. */
function modelTranscript(events: readonly Message[]): Message[] {
  const batchByCall = new Map<string, number>();
  for (const [index, message] of events.entries()) {
    if (message.role !== "assistant") continue;
    for (const call of message.calls ?? []) batchByCall.set(call.id, index);
  }
  const resultsByBatch = new Map<number, ToolMessage[]>();
  for (const message of events) {
    if (message.role !== "tool") continue;
    const batch = batchByCall.get(message.callId);
    if (batch === undefined) throw new TypeError("History contains an unmatched tool result");
    const results = resultsByBatch.get(batch) ?? [];
    results.push(message);
    resultsByBatch.set(batch, results);
  }
  const transcript: Message[] = [];
  for (const [index, message] of events.entries()) {
    if (message.role === "tool") continue;
    transcript.push(message);
    if (message.role === "assistant") transcript.push(...(resultsByBatch.get(index) ?? []));
  }
  return history(transcript);
}

/** Owns the append-only event history and its persistence cursor. The run saves
 * a model-valid transcript at finalization; earlier failures save nothing. */
export class RunHistory {
  private constructor(
    private readonly input: string,
    private readonly messages: Message[],
    private version: number,
    private persisted: number,
    private readonly conversation?: Conversation,
  ) {}

  static *load(input: string, source: HistorySource = {}): Operation<RunHistory> {
    if (typeof input !== "string" || !input.trim())
      throw new TypeError("Agent input must be a nonempty string");
    const {conversation} = source;
    if (conversation && source.messages) throw new TypeError("Use either conversation or messages");
    const snapshot = conversation ? yield* conversation.load() : undefined;
    const messages = history(snapshot?.messages ?? source.messages ?? []);
    const run = new RunHistory(
      input,
      messages,
      snapshot?.version ?? 0,
      messages.length,
      conversation,
    );
    run.append({role: "user", content: input});
    return run;
  }

  snapshot(): Message[] {
    return modelTranscript(this.messages);
  }

  append(...messages: Message[]): void {
    this.messages.push(...messages);
  }

  *save(): Operation<void> {
    if (this.conversation && this.messages.length > this.persisted) {
      const transcript = this.snapshot();
      this.version = yield* this.conversation.append(
        transcript.slice(this.persisted),
        this.version,
      );
      this.persisted = transcript.length;
    }
  }

  *compact(): Operation<void> {
    if (!this.conversation?.compact) return;
    const result = yield* this.conversation.compact();
    if (result === "skipped") return;
    const compacted = yield* this.conversation.load();
    this.messages.splice(0, this.messages.length, ...history(compacted.messages), {
      role: "user",
      content: this.input,
    });
    this.persisted = compacted.messages.length;
    this.version = compacted.version;
  }
}
