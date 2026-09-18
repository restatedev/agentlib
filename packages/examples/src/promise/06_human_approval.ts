// 06: Pause a tool for a human decision, then resume the same agent run.
import * as restate from "@restatedev/restate-sdk";
import {agent, asyncTool, type ApprovalRequest} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

type PendingApproval = ApprovalRequest & {invocationId: string};
const ticketInput = z.object({ticketId: z.string().min(1)});

const support = agent({
  model,
  instructions:
    "Ticket approval lesson. Use closeTicket to close the requested demo ticket. If approval is denied, explain that the ticket was left unchanged and do not try again.",
  tools: {
    closeTicket: asyncTool({
      description: "Close a demo ticket after human approval. No external ticket is changed.",
      input: ticketInput,
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
        const invocationId = ctx.request().id;
        const approvals = new Map<string, PendingApproval>();
        try {
          const result = await support.run(ctx, message, {
            onUpdate(update) {
              if (update.type === "approval-required") {
                approvals.set(update.request.signalName, {...update.request, invocationId});
              } else if (update.type === "tool-end") {
                for (const [signalName, request] of approvals)
                  if (request.call.id === update.call.id) approvals.delete(signalName);
                if (update.result.status === "success") {
                  // Record a successful closure so status shows whether the tool ran.
                  ctx.set("lastClosedTicket", ticketInput.parse(update.call.input).ticketId);
                }
              } else {
                return;
              }
              ctx.set("approvals", [...approvals.values()]);
            },
          });
          return replyText(result);
        } finally {
          ctx.clear("approvals");
        }
      },
    ),
    status: restate.createObjectSharedHandler(async (ctx) => ({
      approvals: (await ctx.get<PendingApproval[]>("approvals")) ?? [],
      lastClosedTicket: await ctx.get<string>("lastClosedTicket"),
    })),
    approve: restate.createObjectSharedHandler(
      {
        input: restate.serde.schema(
          z.object({
            invocationId: z.string().min(1).describe("Copy invocationId from status().approvals."),
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
        const approvals = (await ctx.get<PendingApproval[]>("approvals")) ?? [];
        const pending = approvals.some(
          (request) => request.invocationId === invocationId && request.signalName === signalName,
        );
        if (!pending) return false;
        ctx
          .invocation(restate.InvocationIdParser.fromString(invocationId))
          .signal(signalName)
          .resolve(approved);
        return true;
      },
    ),
  },
});
