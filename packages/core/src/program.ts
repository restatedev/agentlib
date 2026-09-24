import {z} from "zod";
import {ToolError} from "./errors.js";
import {guestLimits, ProgramError, type GuestLimits, type Json} from "./ptc/guest.js";
import {executeProgram} from "./ptc/runtime.js";
import type {BuiltinToolOptions} from "./builtins.js";
import {tool} from "./tool.js";

function isObject(value: Json): value is {[key: string]: Json} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** QuickJS orchestrates the same permitted, policy-checked tools as direct calls. */
export function programTool(
  options: {tools?: string[]; limits?: GuestLimits} & BuiltinToolOptions<{source: string}> = {},
) {
  const limits = guestLimits(options.limits);
  const program = tool({
    // Models write a program body unless the contract ends with a complete example.
    description:
      options.description ??
      [
        "Coordinate tools with a JavaScript program. Use it for parallel lookups, dependent calls, filtering, or aggregation when only a compact result should reach you; call simple tools directly.",
        "The source must evaluate to an async function taking tools, not a program body. Each other tool is a function on tools, called with exactly one input object matching its schema: await tools.lookup({id: 'a'}). Use tools['exact-name'] for names that are not identifiers.",
        "A tool promise resolves to that tool's JSON result, which may be a string rather than an object; failed calls reject. Use Promise.all, any, race, allSettled, and try/catch. Returning ends the program and cancels calls still running.",
        "There is no network, filesystem, process, timer, Date, or Math.random. Search for unfamiliar tools before writing the program.",
        "Return compact JSON. Example, for a tool named lookup: async tools => { const ids = ['a', 'b']; const found = await Promise.all(ids.map((id) => tools.lookup({id}))); return {found}; }",
      ].join("\n"),
    describe: options.describe,
    input: z.object({
      source: z
        .string()
        .min(1)
        .max(64000)
        .describe("JavaScript evaluating to async tools => { ...; return result; }"),
    }),
    *execute({source}, context) {
      const allowed = context.availableTools().filter((name) => name !== context.toolName);
      const names = options.tools?.filter((name) => allowed.includes(name)) ?? allowed;
      try {
        return yield* executeProgram(
          source,
          {
            names,
            *execute(request) {
              const [input] = request.args;
              if (request.args.length !== 1 || !isObject(input))
                return {
                  ok: false,
                  error: {
                    name: "ToolError",
                    message: "Provide exactly one input object matching the tool schema",
                  },
                };
              try {
                return {ok: true, value: yield* context.callTool(request.name, input)};
              } catch (error) {
                if (error instanceof ToolError)
                  return {ok: false, error: {name: "ToolError", message: error.message}};
                throw error;
              }
            },
          },
          limits,
        );
      } catch (error) {
        if (error instanceof ProgramError) throw new ToolError(error.message, "program_error");
        throw error;
      }
    },
  });
  return {...program, program: true as const};
}
export type {GuestLimits} from "./ptc/guest.js";
