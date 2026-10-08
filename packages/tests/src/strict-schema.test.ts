import assert from "node:assert/strict";
import {test} from "node:test";
import {z} from "zod";
import {strictSchema} from "../../core/src/strict-schema.js";

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {io: "input"}) as Record<string, unknown>;

void test("strict schemas close every object and describe value checks strict mode rejects", () => {
  const schema = json(
    z.object({
      city: z.string().min(1).describe("City"),
      mode: z.literal("fast"),
      stops: z.array(z.object({id: z.string(), note: z.string().nullable()})).max(3),
    }),
  );
  assert.deepEqual(strictSchema(schema), {
    type: "object",
    properties: {
      city: {type: "string", description: "City (minLength: 1)"},
      mode: {type: "string", enum: ["fast"]},
      stops: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {id: {type: "string"}, note: {type: ["string", "null"]}},
          required: ["id", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["city", "mode", "stops"],
    additionalProperties: false,
  });
});

void test("hints strict mode drops reach the model through the description", () => {
  const strict = strictSchema(
    json(
      z.object({
        at: z.iso.datetime(),
        code: z.string().regex(/^[A-Z]{3}$/),
      }),
    ),
  )!;
  const properties = strict.properties as Record<string, {description?: string}>;
  assert.match(properties.at!.description!, /format: "date-time"/);
  assert.match(properties.code!.description!, /pattern: "\^\[A-Z\]\{3\}\$"/);
  assert.equal("format" in properties.at!, false);
});

void test("schemas without an exact strict form stay non-strict", () => {
  for (const schema of [
    json(z.object({a: z.string().optional()})),
    json(z.object({a: z.number().default(1)})),
    json(z.object({map: z.record(z.string(), z.string())})),
    json(z.string()),
    {type: "object", properties: {a: {oneOf: [{type: "string"}]}}, required: ["a"]},
    {type: "object", properties: {}, additionalProperties: true},
  ])
    assert.equal(strictSchema(schema), undefined, JSON.stringify(schema));
});

void test("strict conversion keeps unions and leaves the original schema unchanged", () => {
  const schema = json(
    z.object({
      pick: z.union([z.object({mode: z.literal("all")}), z.object({names: z.array(z.string())})]),
    }),
  );
  const before = structuredClone(schema);
  const strict = strictSchema(schema)!;
  assert.deepEqual(schema, before);
  const options = (strict.properties as Record<string, {anyOf: Record<string, unknown>[]}>).pick
    .anyOf;
  assert.ok(options.every((option) => option.additionalProperties === false));
});
