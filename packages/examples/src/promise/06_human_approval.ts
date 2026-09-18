// 06: Pause a tool for a human decision, then resume the same agent run.
import * as restate from "@restatedev/restate-sdk";
import {agent, asyncTool, type ApprovalRequest} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

const support = agent({
  model,
  instructions:
    "Ticket approval lesson. Use closeTicket to close the requested demo ticket. If approval is denied, explain that the ticket was left unchanged and do not try again.",
  tools: {
    closeTicket: asyncTool({
      description: "Close a demo ticket after human approval. No external ticket is changed.",
      input: z.object({ticketId: z.string().min(1)}),
      describe: ({ticketId}) => ({name: "Close ticket", details: {ticketId}}),
      needsApproval: true,
      async execute({ticketId}) {
        // Replace this demo result with an ordinary async API call.
        return {ticketId, status: "closed"};
      },
    }),
  },
});

export const promiseTicketApproval = restate.object({
  name: "PromiseTicketApproval",
  handlers: {
    ask: restate.createObjectHandler(
      {
        input: restate.serde.schema(
          z.string().min(1).meta({default: "Close ticket T-42 after I approve it."}),
        ),
        output: restate.serde.schema(z.string()),
      },
      async (ctx, message) => {
        try {
          const result = await support.run(ctx, message, {
            onApproval(request) {
              ctx.set("approval", request);
            },
          });
          return replyText(result);
        } finally {
          ctx.clear("approval");
        }
      },
    ),
    status: restate.createObjectSharedHandler(async (ctx) => ctx.get<ApprovalRequest>("approval")),
    approve: restate.createObjectSharedHandler(
      {
        input: restate.serde.schema(
          z.object({
            invocationId: z.string().min(1).describe("Copy invocationId from status()."),
            signalName: z
              .string()
              .min(1)
              .describe("Copy signalName from the same approval request."),
            approved: z.boolean().default(false),
          }),
        ),
        output: restate.serde.schema(z.boolean()),
      },
      async (ctx, {invocationId, signalName, approved}) => {
        ctx
          .invocation(restate.InvocationIdParser.fromString(invocationId))
          .signal(signalName)
          .resolve(approved);
        return true;
      },
    ),
  },
});
