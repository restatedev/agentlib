import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Conversation} from "./conversation.js";
import type {Message} from "./types.js";
import {RunInputError} from "./errors.js";
import {estimateTokens} from "./context-size.js";
import {previewMessage, type PreviewSettings} from "./tool-result-preview.js";
import {history} from "./validation.js";

type HistorySource = {conversation?: Conversation; messages?: readonly Message[]};
/** Where the model's view stood when a request was built from it. */
export type ViewMark = {events: number; from: number};
type ToolMessage = Extract<Message, {role: "tool"}>;
export type NoteMessage = Extract<Message, {role: "user"}>;

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
    if (batch === undefined) throw new RunInputError("History contains an unmatched tool result");
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
 * a model-valid transcript at finalization; earlier failures save nothing.
 * Provisional messages, such as a rejected answer, never leave the run. */
export class RunHistory {
  private readonly provisional = new Set<Message>();
  /** Steering notes and their messages, so a truncation can restate what it drops. */
  private readonly steering = new WeakMap<Message, string>();
  /** Set by in-run compaction: the model sees `note` instead of the events before `from`. */
  private view: {from: number; note: NoteMessage} | undefined;
  /** Index of this run's input message among the events. */
  private inputAt: number;
  /** The input tokens the model reported for a request built at `mark`. */
  private measured: {mark: ViewMark; inputTokens: number} | undefined;
  private previews: PreviewSettings | undefined;
  /** Each event as the model sees it, so a step does not preview every result again. */
  private readonly previewed = new WeakMap<Message, Message>();

  private constructor(
    readonly input: string,
    private readonly messages: Message[],
    private version: number,
    private persisted: number,
    private readonly conversation?: Conversation,
  ) {
    this.inputAt = messages.length;
  }

  static *load(
    input: string,
    source: HistorySource = {},
    previews?: PreviewSettings,
  ): Operation<RunHistory> {
    if (typeof input !== "string" || !input.trim())
      throw new RunInputError("Agent input must be a nonempty string");
    const {conversation} = source;
    if (conversation && source.messages)
      throw new RunInputError("Use either conversation or messages");
    const snapshot = conversation ? yield* conversation.load() : undefined;
    const messages = history(snapshot?.messages ?? source.messages ?? []);
    const run = new RunHistory(
      input,
      messages,
      snapshot?.version ?? 0,
      messages.length,
      conversation,
    );
    run.previews = previews;
    run.append({role: "user", content: input});
    return run;
  }

  /** What the model sees during this run, including provisional feedback. */
  snapshot(): Message[] {
    const events = this.shown(this.messages.slice(this.view?.from ?? 0));
    return [...(this.view ? [this.view.note] : []), ...modelTranscript(events)];
  }

  /** What a tool-free finalization sees: the model's view without provisional feedback. */
  finalContext(): Message[] {
    const from = this.view?.from ?? 0;
    const events = this.messages.slice(from).filter((message) => !this.provisional.has(message));
    return [...(this.view ? [this.view.note] : []), ...modelTranscript(this.shown(events))];
  }

  /** Every event so far, whole, for reading a previewed result back. */
  events(): readonly Message[] {
    return this.messages;
  }

  /** Events as the model sees them, with large results previewed. */
  shown(events: readonly Message[]): Message[] {
    return events.map((message) => this.show(message));
  }

  /** Whether any event of the run was previewed, even one compaction has since
   * folded into a note: the note, or the model's memory of it, can carry its ref. */
  hasPreviews(): boolean {
    return this.messages.some((message) => this.show(message) !== message);
  }

  private show(message: Message): Message {
    const {previews} = this;
    if (!previews) return message;
    let shown = this.previewed.get(message);
    if (!shown) {
      shown = previewMessage(message, previews);
      this.previewed.set(message, shown);
    }
    return shown;
  }

  /** Marks the view a request is built from, for `measure`. */
  mark(): ViewMark {
    return {events: this.messages.length, from: this.view?.from ?? 0};
  }

  /** Records the input tokens the model reported for the request built at `mark`. */
  measure(mark: ViewMark, inputTokens: number): void {
    this.measured = {mark, inputTokens};
  }

  /** The tokens the model's view takes: the last reported input plus an
   * estimate for the events added since, or an estimate of the whole view when
   * no report applies, because there was none or compaction replaced the view. */
  viewTokens(): number {
    const {measured} = this;
    if (!measured || measured.mark.from !== (this.view?.from ?? 0))
      return estimateTokens(this.snapshot());
    return (
      measured.inputTokens + estimateTokens(this.shown(this.messages.slice(measured.mark.events)))
    );
  }

  /** The events the model still sees verbatim, in execution order. */
  contextEvents(): {from: number; events: readonly Message[]; note?: NoteMessage} {
    const from = this.view?.from ?? 0;
    return {from, events: this.messages.slice(from), note: this.view?.note};
  }

  /** Whether this run's input message is among the events before `index`. */
  inputBefore(index: number): boolean {
    return this.inputAt < index;
  }

  /** Shows the model `note` instead of the events before `through`. The saved
   * and returned transcript is unchanged. */
  compactContext(through: number, note: NoteMessage): void {
    this.view = {from: through, note};
  }

  /** What the turn commits: the persisted and returned transcript. */
  committed(): Message[] {
    return modelTranscript(this.messages.filter((message) => !this.provisional.has(message)));
  }

  append(...messages: Message[]): void {
    this.messages.push(...messages);
  }

  /** Records a steering update as a runtime note the model sees in order. */
  appendSteering(message: string): void {
    const note: Message = {
      role: "user",
      content: JSON.stringify({source: "agent-runtime", type: "steering", message}),
    };
    this.steering.set(note, message);
    this.messages.push(note);
  }

  /** The steering messages among `events`, oldest first. */
  steeringIn(events: readonly Message[]): string[] {
    return events.flatMap((event) => {
      const message = this.steering.get(event);
      return message === undefined ? [] : [message];
    });
  }

  /** Model-visible for the rest of the run, but never saved or returned. */
  appendProvisional(...messages: Message[]): void {
    for (const message of messages) this.provisional.add(message);
    this.messages.push(...messages);
  }

  *save(): Operation<void> {
    if (!this.conversation) return;
    const transcript = this.committed();
    if (transcript.length === this.persisted) return;
    this.version = yield* this.conversation.append(transcript.slice(this.persisted), this.version);
    this.persisted = transcript.length;
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
    this.inputAt = compacted.messages.length;
    this.version = compacted.version;
  }
}
