import assert from "node:assert/strict";
import {test} from "node:test";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {serviceTool} from "@restate-agents/core";

const refund = r.iface.service(
  "Refund",
  {
    // Object input via Standard Schema -> real JSON Schema, per-handler description.
    process: r.iface.schemas({
      input: z.object({orderId: z.string(), amount: z.number()}),
      output: z.object({refundId: z.string()}),
      description: "Process a refund for an order",
    }),
    // No serde -> no contract schema (open object fallback), no description.
    status: r.iface.json<void, string>(),
    // Scalar input -> must be wrapped so the top level is an object.
    echo: r.iface.schemas({input: z.string(), output: z.string()}),
  },
  {description: "Refund service", metadata: {owner: "payments"}},
);

const counter = r.iface.object("Counter", {
  add: r.iface.schemas({input: z.number(), output: z.number()}),
});

void test("bare interface -> one multiplexed tool that selects any handler", () => {
  const tool = serviceTool(refund);
  const schema = tool.inputSchema as {
    properties: {handler: {enum: string[]}};
    required: string[];
  };
  assert.deepEqual(schema.properties.handler.enum.sort(), ["echo", "process", "status"]);
  assert.deepEqual(schema.required, ["handler"]);
  // The description lists the handlers and their contract descriptions.
  assert.match(tool.description, /Invoke a handler of the "Refund" service/);
  assert.match(tool.description, /- process: Process a refund for an order/);
});

void test("scoped to one handler -> the handler's own description and schema", () => {
  const tool = serviceTool({iface: refund, handler: "process"});
  assert.equal(tool.description, "Process a refund for an order"); // handler description
  // Verbatim: the exact JSON Schema carried by the handler's input serde.
  assert.deepEqual(tool.inputSchema, refund._handlers.process._inputSerde?.jsonSchema);
});

void test("single-handler description falls back handler -> service -> default", () => {
  // `status` has no description, so it falls back to the service description.
  assert.equal(serviceTool({iface: refund, handler: "status"}).description, "Refund service");
  // Explicit override wins.
  assert.equal(
    serviceTool({iface: refund, handler: "status", description: "Live status"}).description,
    "Live status",
  );
});

void test("schemaless handler -> permissive open object; scalar handler -> wrapped", () => {
  assert.deepEqual(serviceTool({iface: refund, handler: "status"}).inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: true,
  });

  const echo = serviceTool({iface: refund, handler: "echo"}).inputSchema as {
    type: string;
    properties: {value: unknown};
  };
  assert.equal(echo.type, "object");
  assert.deepEqual(echo.properties.value, refund._handlers.echo._inputSerde?.jsonSchema);
});

void test("a wrapped schema keeps its references resolvable", () => {
  type Node = {name: string; children: Node[]};
  const node: z.ZodType<Node> = z.lazy(() => z.object({name: z.string(), children: z.array(node)}));
  const tree = r.iface.service("Tree", {
    count: r.iface.schemas({input: z.array(node), output: z.number()}),
  });
  const schema = serviceTool({iface: tree, handler: "count"}).inputSchema;
  const refs: string[] = [];
  JSON.stringify(schema, (key, value: unknown) => {
    if (key === "$ref" && typeof value === "string") refs.push(value);
    return value;
  });
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], schema);
    assert.ok(target && typeof target === "object", `unresolved ${ref}`);
  }
});

void test("inputSchema override replaces the derived schema", () => {
  const schema = {type: "object", properties: {q: {type: "string"}}, required: ["q"]};
  const tool = serviceTool({iface: refund, handler: "process", inputSchema: schema});
  assert.deepEqual(tool.inputSchema, schema);
});

void test("virtual objects require a key", () => {
  // Missing key is a runtime error (and a compile error via the options union).
  assert.throws(() => serviceTool(counter as unknown as r.ServiceDescriptor), /require a "key"/);
  // With a key it builds, multiplexed or scoped.
  const multiplexed = serviceTool({iface: counter, key: "c-1"}).inputSchema as {
    properties: {handler: {enum: string[]}};
  };
  assert.deepEqual(multiplexed.properties.handler.enum, ["add"]);
  const scoped = serviceTool({iface: counter, handler: "add", key: "c-1"}).inputSchema as {
    required: string[];
  };
  // A scalar input is wrapped under `value`.
  assert.deepEqual(scoped.required, ["value"]);
});

// Compile-time contracts (handler-name typechecking, service/object key rules) live in
// `types.ts`, which tsc checks but the runtime test runner does not execute.
