/** Moves a JSON schema under `properties.<property>` of an enclosing object
 * schema. Its local references (`#/$defs/...`, `#`) resolve against the root,
 * so they are rewritten to point into the new location. */
export function nestedSchema(schema: unknown, property: string): unknown {
  const prefix = `#/properties/${property}`;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          (key === "$ref" || key === "$dynamicRef") &&
          typeof child === "string" &&
          child.startsWith("#")
        ) {
          return [key, `${prefix}${child.slice(1)}`];
        }
        return [key, rewrite(child)];
      }),
    );
  };
  return rewrite(schema);
}
