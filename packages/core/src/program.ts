import {z} from "zod";
import {ToolError} from "./errors.js";
import {ProgramError, type GuestLimits} from "./ptc/guest.js";
import {executeProgram} from "./ptc/runtime.js";
import {tool} from "./tool.js";

/** QuickJS orchestrates the same permitted, policy-checked tools as direct calls. */
export function programTool(options: {tools?: string[]; limits?: GuestLimits} = {}) {
  return tool({
    description:
      "Run JavaScript: async tools => { return await tools.name({...}); }. Use exactly one input object per tool. Supports Promise.all/any/race/allSettled. No network, filesystem, process, timers or random. Return compact JSON; tool errors reject. Search for unfamiliar tools before writing code.",
    input: z.object({source: z.string().min(1).max(64000)}),
    *execute({source}, context) {
      const allowed = context.availableTools().filter((name) => name !== context.toolName);
      const names = options.tools
        ? options.tools.filter((name) => allowed.includes(name))
        : allowed;
      try {
        return yield* executeProgram(
          source,
          {
            names,
            *execute(request) {
              if (
                request.args.length !== 1 ||
                typeof request.args[0] !== "object" ||
                request.args[0] === null ||
                Array.isArray(request.args[0])
              )
                return {
                  ok: false,
                  error: {
                    name: "ToolError",
                    message: "Provide exactly one input object matching the tool schema",
                  },
                };
              try {
                return {ok: true, value: yield* context.callTool(request.name, request.args[0])};
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
}
export type {GuestLimits} from "./ptc/guest.js";
