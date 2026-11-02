import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  agentTool,
  handoff,
  journaledModel,
  tool,
  type ModelResponse,
  type ProgressEvent,
} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";
import {testContext} from "./helpers.js";
const ctx = () => testContext("progress");
const done: ModelResponse = {type: "final", text: "done"};
const call = (name: string, id = name, input = {}) => ({id, name, input});
const batch = (...calls: ReturnType<typeof call>[]): ModelResponse => ({type: "tool_calls", calls});
const base = {description: "test", input: z.object({})};

void test("a tool call reports start, display info, progress, and its result in order", async () => {
  const events: ProgressEvent[] = [];
  const a = agent({
    tools: {
      build: tool({
        ...base,
        describe: {name: "Build the project"},
        *execute(_input, context) {
          yield* context.progress({percent: 50});
          return "built";
        },
      }),
    },
    *model(request) {
      return request.step === 1 ? batch(call("build", "b")) : done;
    },
  });
  await r.execute(
    ctx(),
    a.run("go", {
      *onProgress(event) {
        events.push(event);
      },
    }),
  );
  assert.deepEqual(events, [
    {type: "step", step: 1},
    {type: "tool-start", callId: "b", name: "build", input: {}, info: {name: "Build the project"}},
    {type: "tool-info", callId: "b", info: {name: "Build the project"}},
    {type: "tool-progress", callId: "b", value: {percent: 50}},
    {
      type: "tool-end",
      callId: "b",
      name: "build",
      result: {status: "success", output: "built"},
      info: {name: "Build the project"},
    },
    {type: "step", step: 2},
  ]);
});

void test("the run waits for the progress handler before it continues", async () => {
  const order: string[] = [];
  const a = agent({
    *model() {
      order.push("model");
      return done;
    },
  });
  await r.execute(
    ctx(),
    (function* () {
      const gate = r.channel<void>();
      const task = r.spawn(
        a.run("go", {
          *onProgress() {
            yield* gate.receive;
            order.push("progress");
          },
        }),
      );
      yield* gate.send();
      yield* task;
    })(),
  );
  assert.deepEqual(order, ["progress", "model"]);
});

void test("steering and handoffs are reported", async () => {
  const events: ProgressEvent[] = [];
  const specialist = agent({
    name: "specialist",
    *model() {
      return done;
    },
  });
  await r.execute(
    ctx(),
    (function* () {
      const change = r.channel<string>(),
        never = r.channel<string>();
      let listens = 0;
      const a = agent({
        tools: {
          write: tool({
            ...base,
            *execute() {
              yield* change.send("Hand it over");
              return "written";
            },
          }),
          transfer: handoff(specialist),
        },
        *model(request) {
          return request.step === 1 ? batch(call("write")) : batch(call("transfer"));
        },
      });
      yield* a.run("go", {
        controls: {steering: () => (listens++ === 0 ? change.receive : never.receive)},
        *onProgress(event) {
          events.push(event);
        },
      });
    })(),
  );
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("steering") > types.indexOf("tool-start"), types.join());
  assert.deepEqual(
    events.filter((event) => event.type === "steering" || event.type === "handoff"),
    [
      {type: "steering", message: "Hand it over"},
      {type: "handoff", agent: "specialist"},
    ],
  );
});

void test("a sub-agent's events arrive as progress of the parent's call", async () => {
  const events: ProgressEvent[] = [];
  const child = agent({
    *model() {
      return done;
    },
  });
  const parent = agent({
    tools: {delegate: agentTool(child, {description: "Delegate"})},
    *model(request) {
      return request.step === 1 ? batch(call("delegate", "d", {task: "work"})) : done;
    },
  });
  await r.execute(
    ctx(),
    parent.run("go", {
      *onProgress(event) {
        events.push(event);
      },
    }),
  );
  assert.deepEqual(
    events.filter((event) => event.type === "tool-progress"),
    [{type: "tool-progress", callId: "d", value: {type: "step", step: 1}}],
  );
});

void test("an interrupted tool still reports its cancelled result", async () => {
  const events: ProgressEvent[] = [];
  await r.execute(
    ctx(),
    (function* () {
      const stop = r.channel<string>();
      const a = agent({
        finalize: false,
        tools: {
          wait: tool({
            ...base,
            *execute() {
              yield* stop.send("stop");
              yield* r.channel().receive;
              return null;
            },
          }),
        },
        *model() {
          return batch(call("wait"));
        },
      });
      const result = yield* a.run("go", {
        controls: {interrupt: stop.receive},
        *onProgress(event) {
          events.push(event);
        },
      });
      assert.equal(result.status, "interrupted");
    })(),
  );
  assert.deepEqual(events.at(-1), {
    type: "tool-end",
    callId: "wait",
    name: "wait",
    result: {status: "cancelled", message: "stop"},
    info: {name: "wait", details: {}},
  });
});

void test("replay delivers the same events and journaled side effects run once", async () => {
  let published = 0;
  const events: ProgressEvent[][] = [];
  const a = agent({
    model: journaledModel(async (request): Promise<ModelResponse> => {
      return request.messages.length === 1 ? batch(call("lookup", "l")) : done;
    }),
    tools: {
      lookup: tool({
        ...base,
        *execute(_input, context) {
          yield* context.progress("halfway");
          return 42;
        },
      }),
    },
  });
  const handler = (context: Parameters<typeof r.execute>[0]) => {
    const seen: ProgressEvent[] = [];
    events.push(seen);
    return r.execute(
      context,
      a.run("go", {
        *onProgress(event) {
          seen.push(event);
          yield* r.run(
            async () => {
              published++;
            },
            {name: `publish:${seen.length}`},
          );
        },
      }),
    );
  };
  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(events[0]!.length, 5);
  assert.deepEqual(events[1], events[0]);
  assert.equal(published, 5);
});
