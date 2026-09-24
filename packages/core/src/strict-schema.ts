// OpenAI's strict mode guarantees that tool arguments and structured output
// match their schema, but it accepts only a subset of JSON Schema: every
// object closes with additionalProperties false and requires all of its
// properties. Value checks outside that subset are dropped from what the model
// sees; the SDK still validates every call against the original schema.

type Schema = Record<string, unknown>;

/** Keywords strict mode accepts, and value checks it cannot express (dropped). */
const STRUCTURE = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "$ref",
  "$defs",
  "definitions",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);
const DROPPED = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "minLength",
  "maxLength",
  "pattern",
  "format",
]);
const MAX_OBJECT_DEPTH = 10;

class NotStrict extends Error {}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convert(node: unknown, depth: number): Schema {
  if (!isSchema(node)) throw new NotStrict();
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue;
    if (!STRUCTURE.has(key)) throw new NotStrict();
    out[key] = value;
  }
  // An exact enum is equivalent and more widely accepted than const.
  if ("const" in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map((option) => convert(option, depth));
  for (const key of ["$defs", "definitions"]) {
    if (key in out) {
      if (!isSchema(out[key])) throw new NotStrict();
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([name, value]) => [name, convert(value, depth)]),
      );
    }
  }
  if ("items" in out) out.items = convert(out.items, depth);

  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes("object") || "properties" in out) {
    if (depth >= MAX_OBJECT_DEPTH) throw new NotStrict();
    // A map (additionalProperties with a schema) or an open object has no strict form.
    if (out.additionalProperties !== undefined && out.additionalProperties !== false)
      throw new NotStrict();
    const properties = out.properties ?? {};
    if (!isSchema(properties)) throw new NotStrict();
    const required = Array.isArray(out.required) ? out.required : [];
    // An optional property has no strict form: strict mode requires every property.
    if (Object.keys(properties).some((name) => !required.includes(name))) throw new NotStrict();
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [name, convert(value, depth + 1)]),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/** The strict form of an object schema, or undefined when it has none. */
export function strictSchema(schema: Record<string, unknown>): Schema | undefined {
  if (schema.type !== "object") return undefined;
  try {
    return convert(schema, 0);
  } catch (error) {
    if (error instanceof NotStrict) return undefined;
    throw error;
  }
}
