// A run's saves are journaled writes, so a replay must make the same writes in
// the same order. The in-process harness journals only run steps, so this store
// journals its reads and writes as run steps; Restate journals state the same way.
// Each test resumes the invocation from every journal entry and checks that it
// ends with the same output and the same stored conversation.
import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalError, type Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  journaledModel,
  LazyStateConversation,
  tool,
  type ConversationStore,
  type ModelResponse,
} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";

type Store = Map<string, unknown>;

/** A store whose reads and writes are journaled run steps over `state.values`. */
function journaledStore(state: {values: Store; writes: number}): ConversationStore {
  return {
    *get<T>(key: string) {
      const value = yield* r.run(async () => structuredClone(state.values.get(key) ?? null), {
        name: `get ${key}`,
      });
      return (value ?? undefined) as T | undefined;
    },
    *set(key, value) {
      yield* r.run(
        async () => {
          state.writes++;
          state.values.set(key, structuredClone(value));
          return null;
        },
        {name: `set ${key}`},
      );
    },
  };
}

/** Runs `handler` live, then on full replay and resumed from every journal entry. */
async function checkReplay(
  state: {values: Store; writes: number},
  handler: (ctx: Context) => Promise<unknown>,
) {
  // The store after each run step: a resumed attempt starts from what the replayed steps wrote.
  const after: Store[] = [];
  const live = await runHandler(handler, {
    onProposal: () => after.push(structuredClone(state.values)),
  });
  const final = structuredClone(state.values);
  const writes = state.writes;
  assert.ok(writes > 0);

  // A full replay repeats no write: every one comes from the journal.
  state.values = new Map();
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(state.writes, writes);
  assert.equal(state.values.size, 0);

  for (let entries = 1; entries < live.journal.length; entries++) {
    // Entries after the input are run commands, each followed by its completion.
    const completed = Math.floor((entries - 1) / 2);
    state.values = completed ? structuredClone(after[completed - 1]!) : new Map();
    const resumed = await runHandler(handler, {replay: live.journal.slice(0, entries)});
    assert.deepEqual(resumed.output, live.output, `resumed after ${entries} entries`);
    assert.deepEqual(state.values, final, `stored conversation after ${entries} entries`);
  }
  return live.output;
}

const lookup = tool({
  description: "Look up an order",
  input: z.object({}),
  *execute() {
    return "shipped";
  },
});

void test("replay makes a run's saves again in the same order", {timeout: 20000}, async () => {
  const state = {values: new Map() as Store, writes: 0};
  const a = agent({
    tools: {lookup},
    model: journaledModel(async (request): Promise<ModelResponse> => {
      if (request.step === 1)
        return {type: "tool_calls", calls: [{id: "l", name: "lookup", input: {}}]};
      return {type: "final", text: "It has shipped."};
    }),
  });
  const handler = (ctx: Context) =>
    r.execute(
      ctx,
      (function* () {
        const conversation = new LazyStateConversation({store: journaledStore(state)});
        const result = yield* a.run("Where is my order?", {conversation});
        return {status: result.status, saved: (yield* conversation.page()).messages};
      })(),
    );
  const output = (await checkReplay(state, handler)) as {status: string; saved: unknown[]};
  assert.equal(output.status, "completed");
  assert.equal(output.saved.length, 4);
});

void test(
  "replay makes a failed run's saves again, with its failure note",
  {timeout: 20000},
  async () => {
    const state = {values: new Map() as Store, writes: 0};
    const a = agent({
      tools: {lookup},
      model: journaledModel(async (request): Promise<ModelResponse> => {
        if (request.step === 1)
          return {type: "tool_calls", calls: [{id: "l", name: "lookup", input: {}}]};
        throw new TerminalError("model unavailable");
      }),
    });
    const handler = (ctx: Context) =>
      r.execute(
        ctx,
        (function* () {
          const conversation = new LazyStateConversation({store: journaledStore(state)});
          let error: string | undefined;
          try {
            yield* a.run("Where is my order?", {conversation});
          } catch (failure) {
            // Replay restores the journaled failure as a plain TerminalError.
            if (!(failure instanceof TerminalError)) throw failure;
            error = failure.message;
          }
          return {error, saved: (yield* conversation.page()).messages};
        })(),
      );
    const output = (await checkReplay(state, handler)) as {error: string; saved: unknown[]};
    assert.equal(output.error, "model unavailable");
    assert.deepEqual(output.saved.at(-1), {
      role: "user",
      content: JSON.stringify({
        source: "agent-runtime",
        type: "run-failed",
        message: "model unavailable",
      }),
    });
  },
);
