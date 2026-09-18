// 06: Combine conversation history with guarded tools and a typed service call.
import * as restate from "@restatedev/restate-sdk";
import {agent, asyncTool, handlerTool, type Message} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

type TurnInput = {message: string};
type RefundPolicy = {refundWindowDays: number; requiresReceipt: boolean};

export const supportPolicies = restate.service({
  name: "SupportPolicies",
  handlers: {
    refundPolicy: restate.createServiceHandler(
      {
        // Handler-call retries belong to the called handler.
        retryPolicy: {
          maxAttempts: 5,
          initialInterval: {milliseconds: 250},
          exponentiationFactor: 2,
          maxInterval: {seconds: 5},
          onMaxAttempts: "kill",
        },
      },
      async (_ctx: restate.Context): Promise<RefundPolicy> => {
        return {refundWindowDays: 30, requiresReceipt: true};
      },
    ),
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
      before({ticketId}) {
        if (!ticketId.startsWith("T-")) return "Demo ticket IDs start with T-";
      },
      async execute({ticketId}) {
        return {ticketId, status: "open"};
      },
    }),
    refundPolicy: handlerTool({
      description: "Read the refund policy",
      input: z.object({}),
      call(_input, ctx) {
        return ctx.serviceClient(supportPolicies).refundPolicy();
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
      const result = await support.run(ctx, input.message, {messages});

      // After: persist the conversation and the actual outcome of the run.
      ctx.set("messages", result.messages);
      ctx.set("lastStatus", result.status);
      return result;
    },
  },
});
