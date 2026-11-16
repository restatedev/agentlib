import {createToolSearch} from "./tool-search.js";
import type {Tool} from "./types.js";

/** Rejects a tool no run could list: an invalid name, or a handoff that runs in the
 * background. `agent()` checks its own tools when it is defined; the catalog checks
 * the tools a run adds. */
export function checkTool(name: string, definition: {handoff?: unknown; background?: boolean}) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new TypeError(`Invalid tool name: ${name}`);
  if (definition.handoff && definition.background)
    throw new TypeError(`Handoff tool must be foreground: ${name}`);
}

/** A run-local catalog owns validation, search, and schema visibility together. */
export function createToolCatalog<C>(
  tools: Record<string, Tool<C>> = {},
  extra: Record<string, Tool<C>> = {},
) {
  const registry = new Map(Object.entries(tools));
  for (const [name, definition] of Object.entries(extra)) {
    if (registry.has(name)) throw new TypeError(`Duplicate tool name: ${name}`);
    registry.set(name, definition);
  }
  const manifests = [...registry].map(([name, definition]) => {
    checkTool(name, definition);
    return {
      name,
      description: definition.description,
      inputSchema: structuredClone(definition.inputSchema),
    };
  });
  const hasSearch = [...registry.values()].some((definition) => definition.search);
  const search = createToolSearch(
    manifests.filter((manifest) => !registry.get(manifest.name)?.search),
    new Map([...registry].map(([name, definition]) => [name, definition.provider ?? "builtin"])),
  );
  return {
    registry,
    search,
    visibleManifests() {
      return structuredClone(
        manifests.filter(
          (manifest) =>
            !hasSearch ||
            !registry.get(manifest.name)?.deferred ||
            search.loaded.has(manifest.name),
        ),
      );
    },
  };
}

export type ToolCatalog<C> = ReturnType<typeof createToolCatalog<C>>;
