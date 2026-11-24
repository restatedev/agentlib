import {TerminalError} from "@restatedev/restate-sdk";
import {contextLocal, sharedState, state, type Operation} from "@restatedev/restate-sdk-gen";
import type {Message} from "./types.js";
import {history, parseMessages} from "./validation.js";

/** What a run continues from: the messages after the conversation's summary, the
 * summary, and the version the run's next `append` must name. */
export type ConversationSnapshot = {messages: Message[]; version: number; summary?: string};
/** Where a run loads its history and saves its progress. A run saves a batch's
 * tool calls before they run, so a stored history can end with calls that have no
 * results yet, and the next `append` can start with their results. */
export interface Conversation {
  load(): Operation<ConversationSnapshot>;
  append(messages: readonly Message[], expectedVersion: number): Operation<number>;
  /** Stores a run's summary of its context in place of every saved message except
   * the newest `keep`, so the next run loads the summary and those messages instead
   * of the whole history. A run calls it at the save after it summarizes its context
   * (see the agent's `compaction`). Returns false, and stores nothing, when the
   * conversation changed since `expectedVersion` or its summary already covers as
   * many messages. Without this method, every run loads the whole history.
   *
   * The run counts `keep` in the messages it appended, so `append` must store
   * exactly the messages it receives, in order. Storing a summary must not change
   * the version that the run's next `append` names. */
  storeSummary?(summary: string, keep: number, expectedVersion: number): Operation<boolean>;
}
export interface ConversationStore {
  get<T>(key: string): Operation<T | undefined>;
  set<T>(key: string, value: T): Operation<void>;
}
type Meta = {count: number; summary?: {through: number; text: string}};
/** The longest summary `LazyStateConversation` stores. Every save rewrites it with the metadata. */
const MAX_SUMMARY_CHARS = 64000;
/** Another writer changed the conversation since this run loaded it. */
export class ConversationConflictError extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "ConversationConflictError";
  }
}
const CHUNK_SIZE = 32;
/** The value of each key this invocation read or wrote, per store. */
const known = contextLocal<WeakMap<ConversationStore, Map<string, unknown>>>();
const restateStore: ConversationStore = {
  *get<T>(key: string) {
    return (yield* sharedState().get<T>(key)) ?? undefined;
  },
  *set(key, value) {
    state().set(key, value);
  },
};

/** Append-only chunks in an application-owned exclusive Virtual Object handler.
 * No constructor I/O. Use one writer per conversation.
 *
 * A run's summary (see `storeSummary`) replaces the older messages for later runs:
 * `load()` returns the summary and the messages after it. The chunks are never
 * changed, so `page()` still returns every message.
 *
 * Within one invocation, each key is read from the store at most once. Restate
 * journals every state read with its value, so a run that loads, compacts, and
 * saves would otherwise journal the same chunks and metadata several times. The
 * values are kept per invocation, not per instance, so every instance on the
 * same store sees the writes of the others, and a replay reads them from the
 * journal again. A handler that reads within one invocation does not see
 * writes from other invocations after its first read of a key. */
export class LazyStateConversation implements Conversation {
  private readonly store: ConversationStore;
  private readonly metaKey: string;
  private readonly stateKey: string;

  constructor(
    options: {
      metaKey?: string;
      stateKey?: string;
      store?: ConversationStore;
    } = {},
  ) {
    this.store = options.store ?? restateStore;
    this.stateKey = options.stateKey ?? "conversation";
    this.metaKey = options.metaKey ?? `${this.stateKey}/meta`;
  }

  private known(): Map<string, unknown> {
    let stores = known.get();
    if (!stores) known.set((stores = new WeakMap()));
    let values = stores.get(this.store);
    if (!values) stores.set(this.store, (values = new Map()));
    return values;
  }

  /** The key's value as this invocation last read or wrote it. Callers clone
   * what they change: the value is shared for the rest of the invocation. */
  private *read<T>(key: string): Operation<T | undefined> {
    if (this.known().has(key)) return this.known().get(key) as T | undefined;
    const value = yield* this.store.get<T>(key);
    // A write during the read is newer than the value read.
    const values = this.known();
    if (!values.has(key)) values.set(key, value);
    return values.get(key) as T | undefined;
  }

  private *write<T>(key: string, value: T): Operation<void> {
    yield* this.store.set(key, value);
    this.known().set(key, value);
  }

  private *meta(): Operation<Meta> {
    return structuredClone((yield* this.read<Meta>(this.metaKey)) ?? {count: 0});
  }

  private key(index: number) {
    return `${this.stateKey}/${index}`;
  }

  /** Messages in [from, through), read chunk by chunk. */
  private *range(from: number, through: number): Operation<Message[]> {
    const messages: Message[] = [];
    for (let i = Math.floor(from / CHUNK_SIZE); i < Math.ceil(through / CHUNK_SIZE); i++) {
      const chunk = yield* this.read<Message[]>(this.key(i));
      if (!chunk) throw new ConversationConflictError(`Missing conversation chunk: ${i}`);
      const offset = i * CHUNK_SIZE;
      messages.push(...chunk.slice(Math.max(0, from - offset), through - offset));
    }
    return structuredClone(messages);
  }

  *load(): Operation<ConversationSnapshot> {
    const meta = yield* this.meta();
    const range = yield* this.range(meta.summary?.through ?? 0, meta.count);
    // It may end with calls that are still running.
    const messages = history(range, {unfinished: true});
    return {messages, version: meta.count, ...(meta.summary ? {summary: meta.summary.text} : {})};
  }

  *append(messages: readonly Message[], expectedVersion: number): Operation<number> {
    // A save can start with results for calls that the previous save stored.
    const additions = parseMessages(messages);
    const meta = yield* this.meta();
    if (meta.count !== expectedVersion)
      throw new ConversationConflictError("Conversation changed since it was loaded");
    if (!additions.length) return meta.count;
    let offset = 0;
    while (offset < additions.length) {
      const index = Math.floor(meta.count / CHUNK_SIZE);
      const used = meta.count % CHUNK_SIZE;
      const chunk = used ? yield* this.read<Message[]>(this.key(index)) : [];
      if (!chunk || chunk.length !== used)
        throw new ConversationConflictError("Invalid conversation tail");
      const next = additions.slice(offset, offset + CHUNK_SIZE - used);
      yield* this.write(this.key(index), [...chunk, ...next]);
      offset += next.length;
      meta.count += next.length;
    }
    yield* this.write(this.metaKey, meta);
    return meta.count;
  }

  /** Full history remains available even after compaction changes model context. */
  *page(from = 0, limit = 100): Operation<{messages: Message[]; next: number}> {
    const valid = Number.isSafeInteger(from) && from >= 0 && Number.isSafeInteger(limit);
    if (!valid || limit < 1 || limit > 1000) throw new TypeError("Invalid conversation page range");
    const meta = yield* this.meta();
    const end = Math.min(meta.count, from + limit);
    return {messages: yield* this.range(Math.min(from, meta.count), end), next: end};
  }

  /** Replaces every saved message except the newest `keep` with `summary` for later
   * runs. The chunks keep every message, so `page()` still returns them. Returns false
   * when another writer appended since `expectedVersion`, or when the stored summary
   * already covers as many messages. */
  *storeSummary(summary: string, keep: number, expectedVersion: number): Operation<boolean> {
    if (!summary.trim() || summary.length > MAX_SUMMARY_CHARS)
      throw new TypeError(`A conversation summary must have 1 to ${MAX_SUMMARY_CHARS} characters`);
    if (!Number.isSafeInteger(keep) || keep < 0)
      throw new TypeError("keep must be a nonnegative safe integer");
    const meta = yield* this.meta();
    if (meta.count !== expectedVersion) return false;
    const through = meta.count - keep;
    if (through <= (meta.summary?.through ?? 0)) return false;
    // The kept messages must be a valid history on their own. They may end with
    // calls that are still running.
    history(yield* this.range(through, meta.count), {unfinished: true});
    yield* this.write(this.metaKey, {...meta, summary: {through, text: summary}});
    return true;
  }
}
