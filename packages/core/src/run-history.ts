import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Conversation} from "./conversation.js";
import type {Message} from "./types.js";
import {RunInputError} from "./errors.js";
import {estimateTokens} from "./context-size.js";
import {previewMessage, type PreviewSettings} from "./tool-result-preview.js";
import {checkProtocol, history, parseMessages} from "./validation.js";

type HistorySource = {conversation?: Conversation; messages?: readonly Message[]};

function withNote(note: NoteMessage | undefined, transcript: Message[]): Message[] {
  if (note) transcript.unshift(note);
  return transcript;
}

function checkInput(input: unknown, error: string): asserts input is string {
  if (typeof input !== "string" || !input.trim()) throw new RunInputError(error);
}

/** Where the model's view stood when a request was built from it. */
export type ViewMark = {events: number; from: number};
/** Where a fork of the run starts: the events recorded so far, the compacted
 * part of the model's view, and the input tokens the model reported for the
 * request built from them, when it did. Later events and compactions do not move it. */
export type BranchPoint = {
  readonly events: number;
  readonly view: View | undefined;
  readonly measured?: Measured;
};
type View = {readonly from: number; readonly note: NoteMessage};
type Measured = {readonly mark: ViewMark; readonly inputTokens: number};
type ToolMessage = Extract<Message, {role: "tool"}>;
export type NoteMessage = Extract<Message, {role: "user"}>;

/** Events arrive in execution order. Model protocols require each batch's tool
 * results immediately after its assistant call, ahead of intervening steering.
 * Every event was validated when it was recorded, so only the order is checked.
 * With `unfinished`, the last batch may still wait for its results. */
function modelTranscript(events: readonly Message[], unfinished = false): Message[] {
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
  checkProtocol(transcript, undefined, unfinished);
  return transcript;
}

/** The result a run records for a call that an earlier run left without one. */
const INTERRUPTED =
  "Interrupted: the run that made this call ended before the call returned a result. It may have taken effect.";

/** Validates the history a run continues from its conversation, in the same pass
 * that checks it. The run owns the conversation, so it closes calls that a killed
 * run left without results: each gets a cancelled result, which the run's first
 * save stores. Any other problem fails validation. Returns the history and how
 * many results it added. */
function continuedHistory(loaded: readonly Message[]): {messages: Message[]; closed: number} {
  const messages = parseMessages(loaded);
  const open = checkProtocol(messages, undefined, true);
  for (const {id, name} of open)
    messages.push({
      role: "tool",
      callId: id,
      name,
      result: {status: "cancelled", message: INTERRUPTED},
    });
  return {messages, closed: open.length};
}

/** Owns the append-only event history and its persistence cursor. Every message enters
 * a run as a copy the run owns, validated once. Model requests and hooks share these
 * messages instead of copying the history, as the AI SDK does: they read them and never
 * change them. The run saves its committed transcript as it goes (see `save`), and a
 * failed run saves it with its open calls closed and a note on the failure.
 * Provisional messages, such as a rejected answer, never leave the run. */
export class RunHistory {
  private readonly provisional = new Set<Message>();
  /** Steering notes and their messages, so a truncation can restate what it drops. */
  private readonly steering = new WeakMap<Message, string>();
  /** Set by in-run compaction: the model sees `note` instead of the events before `from`. */
  private view: View | undefined;
  /** Index of this run's input message among the events. */
  private inputAt: number;
  /** The input tokens the model reported for a request built at `mark`. */
  private measured: Measured | undefined;
  private previews: PreviewSettings | undefined;
  /** Each event as the model sees it, so a step does not preview every result again. */
  private readonly previewed = new WeakMap<Message, Message>();

  private constructor(
    private inputText: string,
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
    checkInput(input, "Agent input must be a nonempty string");
    const {conversation} = source;
    if (conversation && source.messages)
      throw new RunInputError("Use either conversation or messages");
    const snapshot = conversation ? yield* conversation.load() : undefined;
    // A caller's messages come from a finished or failed run, which closes its calls.
    const {messages, closed} = snapshot
      ? continuedHistory(snapshot.messages)
      : {messages: history(source.messages ?? []), closed: 0};
    const run = new RunHistory(
      input,
      messages,
      snapshot?.version ?? 0,
      messages.length - closed,
      conversation,
    );
    run.previews = previews;
    run.append({role: "user", content: input});
    return run;
  }

  /** Where the history stands now, for a fork started from it later. */
  branchPoint(): BranchPoint {
    const {measured} = this;
    // Only a report for the current view applies: the same events and compaction.
    const current =
      measured?.mark.events === this.messages.length &&
      measured.mark.from === (this.view?.from ?? 0);
    return {events: this.messages.length, view: this.view, ...(current ? {measured} : {})};
  }

  /** A history for a fork: this run's events up to `point`, seen as this run's
   * model saw them, then the fork's `input`. The events are shared, not copied:
   * neither run changes a recorded message. Every event stays readable, including
   * the full results behind previews and events a compaction folded into the
   * note. The fork saves nothing. */
  branch(point: BranchPoint, input: string): RunHistory {
    checkInput(input, "Fork input must be a nonempty string");
    const events = this.messages.slice(0, point.events);
    const fork = new RunHistory(input, events, 0, events.length);
    fork.previews = this.previews;
    fork.view = point.view;
    // The fork's first request repeats the one the model measured, plus its input,
    // so it sizes its view as this run would have, not from an estimate alone.
    fork.measured = point.measured;
    for (const event of events) {
      if (this.provisional.has(event)) fork.provisional.add(event);
      const steering = this.steering.get(event);
      if (steering !== undefined) fork.steering.set(event, steering);
      const shown = this.previewed.get(event);
      if (shown) fork.previewed.set(event, shown);
    }
    fork.append({role: "user", content: input});
    return fork;
  }

  /** This run's input message. */
  get input(): string {
    return this.inputText;
  }

  /** Replaces this run's input message, before any model call has seen it. */
  replaceInput(message: unknown): void {
    // The hook's mistake, not the caller's: a plain error lets a fix resume the run.
    if (typeof message !== "string" || !message.trim())
      throw new TypeError("beforeRun must return a nonempty message");
    this.inputText = message;
    this.messages[this.inputAt] = {role: "user", content: message};
  }

  /** What the model sees during this run, including provisional feedback. */
  snapshot(): Message[] {
    const events = this.shown(this.messages.slice(this.view?.from ?? 0));
    return withNote(this.view?.note, modelTranscript(events));
  }

  /** What a tool-free finalization sees: the model's view without provisional feedback. */
  finalContext(): Message[] {
    const from = this.view?.from ?? 0;
    const events = this.messages.slice(from).filter((message) => !this.provisional.has(message));
    return withNote(this.view?.note, modelTranscript(this.shown(events)));
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
   * no report applies, because there was none or compaction replaced the view.
   * A report already counts `overhead`, what a request adds to its messages. */
  viewTokens(overhead: number): number {
    const {measured} = this;
    if (!measured || measured.mark.from !== (this.view?.from ?? 0))
      return overhead + estimateTokens(this.snapshot());
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

  /** What the turn commits: the persisted and returned transcript. Its messages were
   * validated when they were recorded, and are shared, not copied: the run is over by
   * the time anyone else sees them. */
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

  /** Appends what the run committed since its last save. The run saves after each
   * model call that returns tool calls and after accepted steering, so a shared
   * handler can read a run's progress, and when it ends. A batch's calls are saved
   * before their results. */
  *save(): Operation<void> {
    if (!this.conversation) return;
    const committed = this.messages.filter((message) => !this.provisional.has(message));
    const transcript = modelTranscript(committed, true);
    if (transcript.length === this.persisted) return;
    this.version = yield* this.conversation.append(transcript.slice(this.persisted), this.version);
    this.persisted = transcript.length;
  }

  *compact(): Operation<void> {
    if (!this.conversation?.compact) return;
    const result = yield* this.conversation.compact();
    if (result === "skipped") return;
    const compacted = yield* this.conversation.load();
    const {messages, closed} = continuedHistory(compacted.messages);
    this.messages.splice(0, this.messages.length, ...messages, {
      role: "user",
      content: this.input,
    });
    this.persisted = messages.length - closed;
    this.inputAt = messages.length;
    this.version = compacted.version;
  }
}

const failedRuns = new WeakMap<object, Message[]>();

/** The history of the run that threw `error`, or undefined when no run threw it:
 * its committed messages, with a cancelled result for each call that never
 * finished and a note that says why the run ended. A run with a `conversation`
 * saves this history when the error is terminal; a run with `messages` can pass
 * it to the next run. When several runs threw the same error, it holds the last
 * one's history; for nested runs that is the outermost. */
export function messagesOf(error: unknown): Message[] | undefined {
  const messages = typeof error === "object" && error !== null ? failedRuns.get(error) : undefined;
  return messages && structuredClone(messages);
}

/** Records a failed run's history for `messagesOf` without changing the error. */
export function recordFailedHistory(error: unknown, messages: Message[]): void {
  if (typeof error === "object" && error !== null) failedRuns.set(error, messages);
}
