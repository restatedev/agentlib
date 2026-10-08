// Regression tests for the QuickJS program guest.
import assert from "node:assert/strict";
import test from "node:test";
import {type Context} from "@restatedev/restate-sdk";
import {Guest, ProgramError, type Outcome, type Request} from "../../core/src/ptc/guest.js";
import {executeWithTools as executeProgram} from "./ptc-adapter.js";

void test("invalid guest budgets fail before allocating a VM", () => {
  for (const key of ["maxInterruptChecks", "maxJobsPerDrain", "maxToolCalls"] as const) {
    for (const value of [NaN, Infinity, 0, -1, 1.5]) {
      assert.throws(() => new Guest("return null;", [], {[key]: value}), TypeError);
    }
  }
});

const demoProgram = `
  const completionOrder = [];
  const branches = ["a", "b"].map(async key => {
    const item = await tools.lookup(key);
    const score = await tools.score(item);
    completionOrder.push(key);
    return { key, score };
  });
  const winner = await Promise.race(branches);
  const results = await Promise.all(branches);
  await tools.checkpoint(winner);
  return { winner, results, completionOrder };
`;

type Completion = {id: string; outcome: Outcome};

function requestOutcome(request: Request): Outcome {
  if (request.name === "lookup") {
    return {ok: true, value: {key: request.args[0]!, amount: 10}};
  }
  if (request.name === "score") return {ok: true, value: 20};
  return {ok: true, value: null};
}

function runTrace(
  source: string,
  choose: (requests: Request[]) => Request,
  recorded?: Completion[],
) {
  const guest = new Guest(source, ["lookup", "score", "checkpoint"]);
  const pending: Request[] = [];
  const calls: Request[] = [];
  const events: Completion[] = [];
  try {
    for (let step = 0; step < 100; step++) {
      guest.drain();
      const requests = guest.takeRequests();
      calls.push(...requests);
      pending.push(...requests);
      const state = guest.state();
      if (state.status !== "pending") return {calls, events, state};
      const event = recorded?.[step];
      const request = event ? pending.find((r) => r.id === event.id)! : choose(pending);
      assert.ok(request, "Every delivered completion must have a matching call");
      const outcome = event?.outcome ?? requestOutcome(request);
      pending.splice(pending.indexOf(request), 1);
      events.push({id: request.id, outcome});
      guest.deliver(request.id, outcome);
    }
    throw new Error("Too many turns");
  } finally {
    guest.dispose();
  }
}

void test("multistep race reproduces calls, arguments, winner, and output from a completion trace", () => {
  // Finish branch b first, even though a was issued first.
  const live = runTrace(demoProgram, (requests) => requests.at(-1)!);
  const replay = runTrace(
    demoProgram,
    () => {
      throw new Error("No live I/O on replay");
    },
    live.events,
  );
  assert.deepEqual(replay, live);
  assert.equal(live.state.status, "fulfilled");
  if (live.state.status === "fulfilled") {
    assert.deepEqual(live.state.value, {
      winner: {key: "b", score: 20},
      results: [
        {key: "a", score: 20},
        {key: "b", score: 20},
      ],
      completionOrder: ["b", "a"],
    });
  }
  // The same values alone do NOT preserve the winner if event order changes.
  const otherOrder = runTrace(demoProgram, (requests) => requests[0]!);
  assert.notDeepEqual(otherOrder.state, live.state);
});

void test("native Promise.any/allSettled handle a guest rejection and a fulfillment", () => {
  const source = `
    const a = tools.lookup("a");
    const b = tools.lookup("b");
    const winner = await Promise.any([a, b]);
    const settled = await Promise.allSettled([a, b]);
    return { winner, statuses: settled.map(x => x.status) };
  `;
  const events: Completion[] = [
    {
      id: "call-0",
      outcome: {ok: false, error: {name: "Error", message: "missing"}},
    },
    {id: "call-1", outcome: {ok: true, value: "b"}},
  ];
  const result = runTrace(
    source,
    () => {
      throw new Error("Unexpected I/O");
    },
    events,
  );
  assert.deepEqual(result.state, {
    status: "fulfilled",
    value: {winner: "b", statuses: ["rejected", "fulfilled"]},
  });
});

// Pure guest failures happen before any durable operation. This minimal context
// lets the real gen scheduler run without pretending to implement a journal.
function contextWithRun(run?: (...args: unknown[]) => unknown): Context {
  return {
    request: () => ({attemptCompletedSignal: new AbortController().signal}),
    run:
      run ??
      (() => {
        throw new Error("Unexpected tool call");
      }),
  } as unknown as Context;
}

void test("deterministic program failures terminate instead of retrying the same source", async (t) => {
  const cases: [string, string, RegExp][] = [
    ["syntax", "this is invalid JS", /Guest evaluation failed/],
    ["ordinary throw", 'throw new Error("bad program");', /bad program/],
    ["BigInt output", "return 1n;", /BigInt|bigint/],
    ["cyclic output", "const x = {}; x.self = x; return x;", /circular/i],
    ["undefined output", "return undefined;", /must return JSON/],
    ["missing return", "const x = 1;", /end it with a return statement/],
    ["function output", "return () => 1;", /must return JSON/],
    ["throwing toJSON", 'return { toJSON() { throw new Error("bad JSON"); } };', /bad JSON/],
    [
      "unprintable error",
      `throw {
      get name() { throw null; }, get message() { throw null; }
    };`,
      /Unprintable guest error/,
    ],
  ];
  for (const [name, source, message] of cases) {
    await t.test(name, async () => {
      // Reconstruct twice, just as a repeated invocation attempt would do.
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          executeProgram(contextWithRun(), source, {}),
          (error) => error instanceof ProgramError && message.test(error.message),
        );
      }
    });
  }
});

void test("instruction and microtask budgets are terminal even with guest catch handlers", async () => {
  await assert.rejects(
    executeProgram(
      contextWithRun(),
      `try { while (true) {} } catch { return "caught"; }`,
      {},
      {maxInterruptChecks: 10},
    ),
    (error) => error instanceof ProgramError && /execution budget exceeded/.test(error.message),
  );
  await assert.rejects(
    executeProgram(
      contextWithRun(),
      `
    await new Promise(() => {
      const spin = () => Promise.resolve().then(spin);
      spin();
    });
    return null;
  `,
      {},
      {maxJobsPerDrain: 20},
    ),
    (error) => error instanceof ProgramError && /microtask budget exceeded/.test(error.message),
  );
});

void test("a QuickJS abort while disposing the guest keeps the program's result", async () => {
  // This program leaves objects behind in QuickJS, so freeing its runtime aborts.
  const source = `
    const values = [];
    for (let i = 0; i < 300000; i++) values.push(i);
    values.sort();
    return values.length;
  `;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await executeProgram(contextWithRun(), source, {}), 300000);
  }
  assert.equal(await executeProgram(contextWithRun(), "return 1;", {}), 1);
});

void test("catastrophic regex backtracking is stopped by the execution budget", async () => {
  // Without interrupt checks in the regex engine this blocks the process for hours.
  await assert.rejects(
    executeProgram(
      contextWithRun(),
      `return /(a+)+$/.test("a".repeat(40) + "b");`,
      {},
      {maxInterruptChecks: 100},
    ),
    (error) => error instanceof ProgramError && /execution budget exceeded/.test(error.message),
  );
});

void test("a failed program reports its error at the line and column of the source", async () => {
  const cases: [string, string][] = [
    [
      "const a = {};\nconst b = a.missing.field;\nreturn b;",
      "TypeError: cannot read property 'field' of undefined\n    at <anonymous> (program.js:2:20)",
    ],
    // Columns on the first line do not count the wrapper around the source.
    ["return 1 +;", "SyntaxError: unexpected token in expression: ';'\n    at program.js:1:11"],
    [
      "const helper = () => { throw new RangeError('deep'); };\nhelper();",
      "RangeError: deep\n    at helper (program.js:1:44)\n    at <anonymous> (program.js:2:7)",
    ],
  ];
  for (const [source, expected] of cases) {
    await assert.rejects(
      executeProgram(contextWithRun(), source, {}),
      (error) => error instanceof ProgramError && error.message.endsWith(expected),
    );
  }
});

void test("a failed tool call keeps its error name inside the program", () => {
  const guest = new Guest(
    "try { await tools.lookup({}); } catch (error) { return error.name + ': ' + error.message; }",
    ["lookup"],
  );
  try {
    guest.drain();
    guest.takeRequests();
    guest.deliver("call-0", {ok: false, error: {name: "ToolError", message: "no such ticket"}});
    guest.drain();
    assert.deepEqual(guest.state(), {status: "fulfilled", value: "ToolError: no such ticket"});
  } finally {
    guest.dispose();
  }
});

void test("SDK failures are propagated unchanged and never delivered to guest catch handlers", async () => {
  const failure = new Error("simulated SDK failure");
  await assert.rejects(
    executeProgram(
      contextWithRun(() => {
        throw failure;
      }),
      'try { return await tools.lookup("a"); } catch { return "caught"; }',
      {lookup: async () => "a"},
    ),
    (error) => error === failure,
  );
});

void test("output serialization emits requests during the drain and snapshots only once", () => {
  const guest = new Guest(
    `return {
    toJSON() { tools.lookup("serialized"); return { answer: 42 }; }
  };`,
    ["lookup"],
  );
  try {
    guest.drain();
    assert.deepEqual(guest.takeRequests(), [{id: "call-0", name: "lookup", args: ["serialized"]}]);
    assert.deepEqual(guest.state(), {status: "fulfilled", value: {answer: 42}});
    assert.deepEqual(guest.state(), {status: "fulfilled", value: {answer: 42}});
    assert.deepEqual(guest.takeRequests(), []);
  } finally {
    guest.dispose();
  }
});
