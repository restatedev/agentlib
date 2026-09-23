import {
  client,
  type ClientFuture,
  type Descriptor,
  type HandlerDescriptor,
  type ObjectDescriptor,
  type ServiceDescriptor,
  type WorkflowDescriptor,
} from "@restatedev/restate-sdk-gen";
import {awaitChild, buildTool} from "./tool.js";
import type {JsonValue, Tool} from "./types.js";

/** Any interface descriptor produced by `iface.service/object/workflow`. */
type AnyDescriptor = Descriptor<
  string,
  Record<string, HandlerDescriptor>,
  "service" | "object" | "workflow"
>;

/** A fixed virtual-object/workflow key, or one derived from the (validated) tool input. */
export type KeyArg = string | ((input: JsonValue) => string);

/** Tool overrides that are not derived from the contract. */
type Overrides = {
  /** Override the tool description. */
  description?: string;
  background?: boolean;
  deferred?: boolean;
  provider?: string;
  needsApproval?: boolean;
  /** Precise input schema for the chosen handler (single-handler form only). */
  inputSchema?: Record<string, unknown>;
};

/**
 * Options for {@link serviceTool}. Omit `handler` to get one multiplexed tool that can
 * invoke any handler of the interface; pass `handler` (typechecked against the interface)
 * to scope the tool to a single handler.
 */
export type ServiceToolOptions<H extends Record<string, HandlerDescriptor>> = Overrides &
  (
    | {iface: ServiceDescriptor<string, H>; handler?: keyof H & string; key?: never}
    | {
        iface: ObjectDescriptor<string, H> | WorkflowDescriptor<string, H>;
        handler?: keyof H & string;
        key: KeyArg;
      }
  );

function isPlainObjectSchema(schema: Record<string, unknown>): boolean {
  return (schema as {type?: unknown}).type === "object";
}

function isNullishOrEmptyObject(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0
  );
}

/**
 * The argument to pass to the client. Handlers without a declared serde (`iface.json`)
 * use the default JSON serde, where a nullish/empty value serializes to empty bytes —
 * which is exactly what a `void` handler requires. Handlers declared with a serde
 * (`iface.schemas`/`iface.serdes`) validate their own input, so the value is passed
 * through untouched (an empty object stays an empty object).
 */
function callArgFor(
  handler: HandlerDescriptor,
  value: JsonValue | undefined,
): JsonValue | undefined {
  if (handler._inputSerde !== undefined) return value;
  return isNullishOrEmptyObject(value) ? undefined : value;
}

/** Turn a {@link KeyArg} into a resolver, enforcing the service/object key contract. */
function normalizeKey(
  descriptor: AnyDescriptor,
  key: KeyArg | undefined,
): ((input: JsonValue | undefined) => string) | undefined {
  if (descriptor._kind === "service") {
    if (key !== undefined)
      throw new TypeError(`Service "${descriptor.name}" tools do not take a key.`);
    return undefined;
  }
  if (key === undefined)
    throw new TypeError(
      `${descriptor._kind} "${descriptor.name}" tools require a "key" (string or resolver).`,
    );
  return typeof key === "function" ? (input) => key(input ?? null) : () => key;
}

/** Build a tool scoped to one handler, with the handler's own input schema. */
function buildSingleHandlerTool<C>(
  descriptor: AnyDescriptor,
  handlerName: string,
  overrides: Overrides,
  resolveKey: ((input: JsonValue | undefined) => string) | undefined,
): Tool<C> {
  const handler = descriptor._handlers[handlerName];
  if (!handler)
    throw new TypeError(
      `Handler "${handlerName}" not found on ${descriptor._kind} "${descriptor.name}".`,
    );

  const description =
    overrides.description ??
    handler._description ??
    descriptor._description ??
    `Invoke the "${handlerName}" handler of the "${descriptor.name}" ${descriptor._kind}.`;

  // Contract schema is present only for handlers declared via `iface.schemas`.
  const contractSchema = handler._inputSerde?.jsonSchema as Record<string, unknown> | undefined;
  const base = overrides.inputSchema ??
    contractSchema ?? {type: "object", properties: {}, additionalProperties: true};

  // Model providers require an object at the top level; wrap scalars/arrays under `value`.
  const wrap = !isPlainObjectSchema(base);
  const inputSchema = wrap
    ? {
        type: "object",
        properties: {value: base},
        required: ["value"],
        additionalProperties: false,
      }
    : base;

  return buildTool<JsonValue, C>({
    description,
    inputSchema,
    background: overrides.background,
    deferred: overrides.deferred,
    provider: overrides.provider,
    parseInput(raw) {
      return {ok: true, data: wrap ? ((raw as {value?: JsonValue} | null)?.value ?? null) : raw};
    },
    lifecycle: {
      needsApproval: overrides.needsApproval,
      *execute(data) {
        const output = yield* awaitChild(
          callHandler(descriptor, handlerName, resolveKey?.(data), callArgFor(handler, data)),
        );
        // z.json() output validation rejects `undefined` (a void-output handler).
        return output ?? null;
      },
    },
  });
}

type MultiplexInput = {handler: string; input?: JsonValue};

/** Build a single tool that can invoke any handler of the interface. */
function buildMultiplexedTool<C>(
  descriptor: AnyDescriptor,
  overrides: Overrides,
  resolveKey: ((input: JsonValue | undefined) => string) | undefined,
): Tool<C> {
  const names = Object.keys(descriptor._handlers);

  const header =
    overrides.description ??
    `Invoke a handler of the "${descriptor.name}" ${descriptor._kind}. ` +
      `Set "handler" to the handler to call and pass its arguments in "input".`;
  const lines = names.map((name) => {
    const handler = descriptor._handlers[name];
    const desc = handler._description ? `: ${handler._description}` : "";
    const schema = handler._inputSerde?.jsonSchema;
    const schemaText = schema ? ` (input: ${JSON.stringify(schema)})` : "";
    return `- ${name}${desc}${schemaText}`;
  });
  const description = [header, "Handlers:", ...lines].join("\n");

  const inputSchema = {
    type: "object",
    properties: {
      handler: {
        type: "string",
        enum: names,
        description: "Name of the handler to invoke.",
      },
      input: {
        description: "Arguments for the chosen handler; omit when the handler takes none.",
      },
    },
    required: ["handler"],
    additionalProperties: false,
  };

  return buildTool<MultiplexInput, C>({
    description,
    inputSchema,
    background: overrides.background,
    deferred: overrides.deferred,
    provider: overrides.provider,
    parseInput(raw) {
      const obj = (raw ?? {}) as {handler?: unknown; input?: JsonValue};
      if (typeof obj.handler !== "string" || !(obj.handler in descriptor._handlers))
        return {
          ok: false,
          error: `Unknown handler ${JSON.stringify(obj.handler)}; expected one of: ${names.join(", ")}.`,
        };
      return {ok: true, data: {handler: obj.handler, input: obj.input}};
    },
    lifecycle: {
      needsApproval: overrides.needsApproval,
      *execute(data) {
        const handler = descriptor._handlers[data.handler];
        const output = yield* awaitChild(
          callHandler(
            descriptor,
            data.handler,
            resolveKey?.(data.input),
            callArgFor(handler, data.input),
          ),
        );
        return output ?? null;
      },
    },
  });
}

function isDescriptor(arg: unknown): arg is AnyDescriptor {
  return (
    typeof arg === "object" && arg !== null && "_handlers" in arg && "_kind" in arg && "name" in arg
  );
}

type Handlers = Record<string, HandlerDescriptor>;
type HandlerClient = Record<string, (arg?: JsonValue) => ClientFuture<JsonValue>>;

/** Call a handler for a resolved key; the free `client()` reads the ambient operation context. */
function callHandler(
  descriptor: AnyDescriptor,
  handler: string,
  key: string | undefined,
  callArg: JsonValue | undefined,
): ClientFuture<JsonValue> {
  const handlers =
    key === undefined
      ? client(descriptor as Descriptor<string, Handlers, "service">)
      : client(descriptor as Descriptor<string, Handlers, "object" | "workflow">, key);
  return (handlers as HandlerClient)[handler](callArg);
}

/**
 * Turn a Restate interface into a single agent tool.
 *
 * - `serviceTool(refundIface)` — one tool that can invoke any handler of the service
 *   (the model selects the handler via the tool input).
 * - `serviceTool({ iface: refundIface, handler: "issueRefund" })` — a tool scoped to one
 *   handler; `handler` is typechecked against the interface's handler names.
 *
 * Virtual objects and workflows additionally require a `key` (a string or a resolver).
 *
 * @example
 * ```ts
 * tools: {
 *   refund: serviceTool(refundIface),
 *   issueRefund: serviceTool({ iface: refundIface, handler: "issueRefund" }),
 * }
 * ```
 */
export function serviceTool<H extends Record<string, HandlerDescriptor>, C = unknown>(
  iface: ServiceDescriptor<string, H>,
): Tool<C>;
export function serviceTool<H extends Record<string, HandlerDescriptor>, C = unknown>(
  options: ServiceToolOptions<H>,
): Tool<C>;
export function serviceTool<C = unknown>(
  arg: ServiceDescriptor | ServiceToolOptions<Record<string, HandlerDescriptor>>,
): Tool<C> {
  const options = (isDescriptor(arg) ? {iface: arg} : arg) as Overrides & {
    iface: unknown;
    handler?: string;
    key?: KeyArg;
  };
  const {iface, handler, key, ...overrides} = options;
  const descriptor = iface as AnyDescriptor;
  const resolveKey = normalizeKey(descriptor, key);
  return handler === undefined
    ? buildMultiplexedTool<C>(descriptor, overrides, resolveKey)
    : buildSingleHandlerTool<C>(descriptor, handler, overrides, resolveKey);
}
