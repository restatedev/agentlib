import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Conversation} from "./conversation.js";
import type {Message} from "./types.js";
import {history} from "./validation.js";

type HistorySource = {conversation?: Conversation; messages?: readonly Message[]};

/** Owns committed messages, buffered observations, and the persistence cursor.
 * Callers receive snapshots; only observations invalidate an in-flight plan. */
export class RunHistory {
  private readonly observations: Message[] = [];
  private currentRevision = 0;

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

  get revision(): number {
    return this.currentRevision;
  }

  snapshot(): Message[] {
    return structuredClone(this.messages);
  }

  append(...messages: Message[]): void {
    this.messages.push(...messages);
  }

  observe(value: Record<string, unknown>): void {
    this.observations.push({
      role: "user",
      content: JSON.stringify({source: "agent-runtime", ...value}),
    });
    this.currentRevision++;
  }

  flush(): void {
    this.append(...this.observations.splice(0));
  }

  *save(): Operation<void> {
    if (this.conversation && this.messages.length > this.persisted) {
      this.version = yield* this.conversation.append(
        this.messages.slice(this.persisted),
        this.version,
      );
      this.persisted = this.messages.length;
    }
  }

  *compact(): Operation<void> {
    if (!this.conversation?.compact) return;
    yield* this.conversation.compact();
    const compacted = yield* this.conversation.load();
    this.messages.splice(0, this.messages.length, ...history(compacted.messages), {
      role: "user",
      content: this.input,
    });
    this.persisted = compacted.messages.length;
    this.version = compacted.version;
  }
}
