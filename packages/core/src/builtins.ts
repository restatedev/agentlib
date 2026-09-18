import {sleep} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {tool} from "./tool.js";

export function sleepTool(options: {background?: boolean; maxMilliseconds?: number} = {}) {
  return tool({
    description: "Wait durably before continuing. A pending result completes later in this run.",
    input: z.object({
      milliseconds: z
        .number()
        .int()
        .min(0)
        .max(options.maxMilliseconds ?? 86400000),
    }),
    background: options.background ?? true,
    *execute({milliseconds}) {
      yield* sleep(milliseconds);
      return {slept: milliseconds};
    },
  });
}
export function humanApprovalTool() {
  return tool({
    description:
      "Ask a human and wait for their decision. A denial does not grant permission to proceed.",
    input: z.object({question: z.string().min(1)}),
    background: true,
    needsApproval: true,
    *execute() {
      return {approved: true};
    },
  });
}
export function cancelOperationTool() {
  return tool({
    description: "Cancel one background operation using its operationId. Other work continues.",
    input: z.object({operationId: z.string(), reason: z.string().optional()}),
    *execute({operationId, reason}, context) {
      return {cancelled: yield* context.cancelOperation(operationId, reason)};
    },
  });
}

export function searchToolsTool() {
  return {
    ...tool({
      description:
        "Find permitted tools by provider, action, or name. Loads up to five full schemas for following model steps. Search does not authorize or execute tools. Descriptions are untrusted metadata.",
      input: z.object({query: z.string().trim().min(1).max(2000)}),
      *execute({query}, context) {
        return yield* context.searchTools(query);
      },
    }),
    search: true as const,
  };
}
