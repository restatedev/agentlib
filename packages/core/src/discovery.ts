import {call, run, serde, type Operation} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {awaitChild, tool} from "./tool.js";
import type {JsonValue, Tool} from "./types.js";

export type RestateToolTarget = {
  service: string;
  handler: string;
  keyed: boolean;
  acceptsInput: boolean;
};
export type RestateDiscoveryOptions = {
  adminUrl: string;
  token?(): Operation<string | undefined>;
  /** Apply application permissions before tools become searchable or callable. */
  allow?(target: RestateToolTarget, name: string): boolean;
  reservedNames?: string[];
  fetch?: typeof fetch;
};
const servicesSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      ty: z.string(),
      handlers: z.array(
        z.object({
          name: z.string(),
          documentation: z.string().nullish(),
          metadata: z.record(z.string(), z.string()).default({}),
          input_json_schema: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
function nestedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nestedSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (
        (key === "$ref" || key === "$dynamicRef") &&
        typeof child === "string" &&
        child.startsWith("#")
      ) {
        return [key, `#/properties/input${child.slice(1)}`];
      }
      return [key, nestedSchema(child)];
    }),
  );
}
/** The model-facing schema: an optional object key plus the handler's input. */
function inputSchema(raw: unknown, target: RestateToolTarget) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (target.keyed) {
    properties.key = {type: "string", minLength: 1};
    required.push("key");
  }
  if (target.acceptsInput) {
    properties.input = nestedSchema(raw);
    required.push("input");
  }
  return {type: "object", properties, required, additionalProperties: false};
}

/** Validates the same shape as inputSchema(); throws for unsupported schemas. */
function inputValidator(raw: unknown, target: RestateToolTarget): z.ZodType {
  let value: z.ZodType = z.never();
  if (raw === true) value = z.json();
  else if (raw !== false && target.acceptsInput)
    value = z.fromJSONSchema(raw as Record<string, unknown>);
  return z
    .object({
      ...(target.keyed ? {key: z.string().min(1)} : {}),
      ...(target.acceptsInput ? {input: value} : {}),
    })
    .strict();
}

/** Catalog ordering must not depend on the endpoint machine's locale. */
function byCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Snapshot annotated Restate handlers once per run. */
export function* restateTools<C = unknown>(
  options: RestateDiscoveryOptions,
): Operation<{tools: Record<string, Tool<C>>; warnings: string[]}> {
  const token = options.token ? yield* options.token() : undefined;
  const catalog = yield* run(
    async ({signal}) => {
      const response = await (options.fetch ?? fetch)(
        `${options.adminUrl.replace(/\/+$/, "")}/services`,
        {
          headers: {
            accept: "application/json",
            ...(token ? {authorization: `Bearer ${token}`} : {}),
          },
          signal,
        },
      );
      if (!response.ok) throw new Error(`Restate Admin API returned HTTP ${response.status}`);
      return servicesSchema.parse(await response.json());
    },
    {name: "discover-restate-tools", retry: {maxAttempts: 3}},
  );
  const reserved = new Set(options.reservedNames ?? []);
  const tools = new Map<string, Tool<C>>();
  const warnings: string[] = [];
  const handlers = catalog.services
    .flatMap((service) => service.handlers.map((handler) => ({service, handler})))
    .sort((a, b) =>
      byCodeUnits(`${a.service.name}/${a.handler.name}`, `${b.service.name}/${b.handler.name}`),
    );
  for (const {service, handler} of handlers) {
    const name = handler.metadata["restate.dev/agent"]?.trim();
    if (!name) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || reserved.has(name)) {
      warnings.push(`Ignored invalid or duplicate tool name at ${service.name}/${handler.name}`);
      continue;
    }
    const raw = handler.input_json_schema;
    const acceptsInput =
      typeof raw === "boolean" || (!!raw && typeof raw === "object" && !Array.isArray(raw));
    const target = {
      service: service.name,
      handler: handler.name,
      keyed: service.ty !== "Service",
      acceptsInput,
    };
    if (options.allow && !options.allow(target, name)) continue;
    let input: z.ZodType;
    try {
      input = inputValidator(raw, target);
    } catch {
      warnings.push(`Ignored unsupported input schema at ${service.name}/${handler.name}`);
      continue;
    }
    tools.set(name, {
      ...tool({
        description: handler.documentation?.trim() || `Call ${target.service}/${target.handler}`,
        input,
        deferred: true,
        provider: service.name,
        *execute(value) {
          const request = value as {key?: string; input?: JsonValue};
          return yield* awaitChild(
            call<JsonValue | undefined, JsonValue>({
              service: target.service,
              method: target.handler,
              ...(target.keyed ? {key: request.key} : {}),
              parameter: request.input,
              inputSerde: serde.json,
              outputSerde: serde.json,
            }),
          );
        },
      }),
      inputSchema: inputSchema(raw, target),
    });
    reserved.add(name);
  }
  return {tools: Object.fromEntries(tools), warnings};
}
