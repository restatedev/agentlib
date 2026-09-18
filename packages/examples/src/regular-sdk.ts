import * as restate from "@restatedev/restate-sdk";
import {call, execute} from "@restatedev/restate-sdk-gen";
import {agent, asyncTool, handlerTool, type Message} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "./shared.js";

type TurnInput = {message: string};
type RefundPolicy = {refundWindowDays: number; requiresReceipt: boolean};

export const supportPolicies = restate.service({
  name: "SupportPolicies",
  handlers: {
    async refundPolicy(_ctx: restate.Context): Promise<RefundPolicy> {
      return {refundWindowDays: 30, requiresReceipt: true};
    },
  },
});

const support = agent({
  model,
  instructions:
    "Help the user with their support ticket. Use tools to check ticket facts and policy.",
  maxSteps: 7,
  tools: {
    lookupTicket: asyncTool({
      description: "Look up a demo ticket. This does not connect to a ticketing system.",
      input: z.object({ticketId: z.string().min(1)}),
      describe: ({ticketId}) => ({name: "Look up ticket", details: {ticketId}}),
      async execute({ticketId}) {
        // asyncTool journals ordinary I/O; the demo returns a fixed record.
        return {ticketId, status: "open"};
      },
    }),
    refundPolicy: handlerTool({
      description: "Read the refund policy",
      input: z.object({}),
      call() {
        return call<void, RefundPolicy>({
          service: supportPolicies.name,
          method: "refundPolicy",
          parameter: undefined,
          inputSerde: restate.serde.json,
          outputSerde: restate.serde.json,
        });
      },
    }),
  },
});

export const regularSdkSupport = restate.object({
  name: "RegularSdkSupport",
  handlers: {
    async ask(ctx: restate.ObjectContext, input: TurnInput) {
      // Before: load this session's conversation using the regular SDK.
      const messages = (await ctx.get<Message[]>("messages")) ?? [];

      // During: the existing agent owns its model calls and concurrent tools.
      const result = await execute(ctx, support.run(input.message, {messages}));

      // After: persist the conversation and the actual outcome of the run.
      ctx.set("messages", result.messages);
      ctx.set("lastStatus", result.status);
      return result;
    },
  },
});
