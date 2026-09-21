// 08: Expose a whole Restate service to the agent as one tool, from its `iface` contract.
import * as restate from "@restatedev/restate-sdk";
import {agent, serviceTool} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

// The interface (contract). Its descriptions are surfaced to the model by serviceTool.
export const refundIface = restate.iface.service("PromiseRefundService", {
  getPolicy: restate.iface.schemas({
    input: z.object({}),
    output: z.object({refundWindowDays: z.number(), requiresReceipt: z.boolean()}),
    description: "Read the refund policy.",
  }),
  issueRefund: restate.iface.schemas({
    input: z.object({orderId: z.string(), amountCents: z.number().int().positive()}),
    output: z.object({refundId: z.string(), status: z.string()}),
    description: "Issue a refund for an order. Amount is in cents.",
  }),
});

// The implementation — an ordinary regular-SDK service bound in app.ts.
export const refundService = restate.implement(refundIface, {
  handlers: {
    getPolicy: async () => ({refundWindowDays: 30, requiresReceipt: true}),
    issueRefund: async (_ctx, {orderId}) => ({refundId: `re_${orderId}`, status: "issued"}),
  },
});

// One tool exposes every handler of the service; the model selects which to invoke.
const support = agent({
  model,
  instructions:
    "Help the user with refunds. Use the refund tool to read the policy and to issue refunds.",
  maxSteps: 6,
  tools: {
    refund: serviceTool(refundIface),
  },
});

export const refundAgent = restate.service({
  name: "PromiseRefundAgent",
  handlers: {
    ask: restate.createServiceHandler(
      {
        input: restate.serde.schema(
          z
            .string()
            .min(1)
            .meta({default: "Refund order O-99 for $12.50 and tell me the refund policy."}),
        ),
        output: restate.serde.schema(z.string()),
      },
      async (ctx, message) => {
        const result = await support.run(ctx, message);
        return replyText(result);
      },
    ),
  },
});
