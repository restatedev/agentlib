import {z} from "zod";
import {ToolError} from "./errors.js";
import {ProgramError, type GuestLimits, type Json} from "./ptc/guest.js";
import {executeProgram} from "./ptc/runtime.js";
import {tool} from "./tool.js";

function isObject(value: Json): value is {[key: string]: Json} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** QuickJS orchestrates the same permitted, policy-checked tools as direct calls. */
export function programTool(options: {tools?: string[]; limits?: GuestLimits} = {}) {
  const program = tool({
    description:
      "Run JavaScript: async tools => { return await tools.name({...}); }. Use exactly one input object per tool. Supports Promise.all/any/race/allSettled. No network, filesystem, process, timers or random. Return compact JSON; tool errors reject. Search for unfamiliar tools before writing code.",
    input: z.object({source: z.string().min(1).max(64000)}),
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
          options.limits,
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
