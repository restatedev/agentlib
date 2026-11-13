import {z} from "zod";
import {ToolError} from "./errors.js";
import {guestLimits, ProgramError, type GuestLimits, type Json} from "./ptc/guest.js";
import {executeProgram} from "./ptc/runtime.js";
import type {BuiltinToolOptions} from "./builtins.js";
import {tool} from "./tool.js";

function isObject(value: Json): value is {[key: string]: Json} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CallStatus = "ok" | "error" | "cancelled";

/** Effects a failed program leaves behind: its calls by tool, in call order. */
function callSummary(calls: {name: string; status: CallStatus}[]): string {
  if (calls.length === 0) return "No tool calls were made.";
  const byTool = new Map<string, Record<CallStatus, number>>();
  for (const {name, status} of calls) {
    const counts = byTool.get(name) ?? {ok: 0, error: 0, cancelled: 0};
    counts[status]++;
    byTool.set(name, counts);
  }
  const tools = [...byTool].map(([name, counts]) => {
    const parts = (["ok", "error", "cancelled"] as const)
      .filter((status) => counts[status] > 0)
      .map((status) => `${counts[status]} ${status}`);
    return `${name} (${parts.join(", ")})`;
  });
  return `Tool calls made before the failure, which are not undone: ${tools.join(", ")}.`;
}

/** The name of the program tool a run adds when an agent has tools to call. */
export const PROGRAM_TOOL = "run_program";

/** QuickJS orchestrates the same permitted, policy-checked tools as direct calls. */
export function programTool(
  options: {tools?: string[]; limits?: GuestLimits} & BuiltinToolOptions<{source: string}> = {},
) {
  const limits = guestLimits(options.limits);
  const program = tool({
    description:
      options.description ??
      [
        "Coordinate tools with a JavaScript program. Use it for parallel lookups, dependent calls, filtering, or aggregation when only a compact result should reach you; call simple tools directly.",
        "The source is the body of an async function: top-level await and return work. Each other tool is a function on tools, called with exactly one input object matching its schema: await tools.lookup({id: 'a'}). Use tools['exact-name'] for names that are not identifiers.",
        "A tool promise resolves to that tool's JSON result, which may be a string rather than an object; failed calls reject. Use Promise.all, any, race, allSettled, and try/catch. Returning ends the program and cancels calls still running.",
        "There is no network, filesystem, process, timer, Date, or Math.random. Search for unfamiliar tools before writing the program.",
        "Return compact JSON. Example, for a tool named lookup: const ids = ['a', 'b']; const found = await Promise.all(ids.map((id) => tools.lookup({id}))); return {found};",
      ].join("\n"),
    describe: options.describe,
    input: z.object({
      source: z.string().min(1).max(64000).describe("Body of an async function; return the result"),
    }),
    *execute({source}, context) {
      const allowed = context.availableTools().filter((name) => name !== context.toolName);
      const names = options.tools?.filter((name) => allowed.includes(name)) ?? allowed;
      // A call still running when the program stops was cancelled.
      const calls: {name: string; status: CallStatus}[] = [];
      try {
        return yield* executeProgram(
          source,
          {
            names,
            *execute(request) {
              const call: {name: string; status: CallStatus} = {
                name: request.name,
                status: "cancelled",
              };
              calls.push(call);
              const [input] = request.args;
              if (request.args.length !== 1 || !isObject(input)) {
                call.status = "error";
                return {
                  ok: false,
                  error: {
                    name: "ToolError",
                    message: "Provide exactly one input object matching the tool schema",
                  },
                };
              }
              try {
                const value = yield* context.callTool(request.name, input);
                call.status = "ok";
                return {ok: true, value};
              } catch (error) {
                if (!(error instanceof ToolError)) throw error;
                call.status = "error";
                return {ok: false, error: {name: "ToolError", message: error.message}};
              }
            },
          },
          limits,
        );
      } catch (error) {
        if (error instanceof ProgramError)
          throw new ToolError(`${error.message}\n\n${callSummary(calls)}`, "program_error");
        throw error;
      }
    },
  });
  return {...program, program: true as const};
}
export type {GuestLimits} from "./ptc/guest.js";
