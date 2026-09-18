// 06: Pause a tool for a human decision, then resume the same agent run.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, tool, type ApprovalRequest} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

type PendingApproval = ApprovalRequest & {invocationId: string};

const support = agent({
  model,
  instructions:
    "Ticket approval lesson. Use closeTicket to close the requested demo ticket. If approval is denied, explain that the ticket was left unchanged and do not try again.",
  tools: {
    closeTicket: tool({
      description: "Record a demo ticket as closed in this object's state after human approval.",
      input: z.object({ticketId: z.string().min(1)}),
      describe: ({ticketId}) => ({name: "Close ticket", details: {ticketId}}),
      needsApproval: true,
      *execute({ticketId}) {
        // This state change happens only after approval. No external ticket is changed.
        restate.state().set("lastClosedTicket", ticketId);
        return {ticketId, status: "closed"};
      },
    }),
  },
});

export const ticketApproval = restate.object({
  name: "TicketApproval",
  handlers: {
    ask: restate.schemas(
      {
        input: z.string().min(1).meta({default: "Close ticket T-42 after I approve it."}),
        output: z.string(),
      },
      function* (message) {
        const invocationId = restate.handlerRequest().id;
        const approvals = new Map<string, PendingApproval>();
        try {
          const result = yield* support.run(message, {
            *onUpdate(update) {
              if (update.type === "approval-required") {
                approvals.set(update.request.signalName, {...update.request, invocationId});
              } else if (update.type === "tool-end") {
                for (const [signalName, request] of approvals)
                  if (request.call.id === update.call.id) approvals.delete(signalName);
              } else {
                return;
              }
              restate.state().set("approvals", [...approvals.values()]);
            },
          });
          return replyText(result);
        } finally {
          restate.state().clear("approvals");
        }
      },
    ),
    *status() {
      return {
        approvals: (yield* restate.sharedState().get<PendingApproval[]>("approvals")) ?? [],
        lastClosedTicket: yield* restate.sharedState().get<string>("lastClosedTicket"),
      };
    },
    approve: restate.schemas(
      {
        input: z.object({
          invocationId: z.string().min(1).describe("Copy invocationId from status().approvals."),
          signalName: z.string().min(1).describe("Copy signalName from the same approval request."),
          approved: z.boolean().default(false),
        }),
        output: z.boolean(),
      },
      function* ({invocationId, signalName, approved}) {
        const approvals = (yield* restate.sharedState().get<PendingApproval[]>("approvals")) ?? [];
        const pending = approvals.some(
          (request) => request.invocationId === invocationId && request.signalName === signalName,
        );
        if (!pending) return false;
        restate.invocation(invocationId).signal(signalName).resolve(approved);
        return true;
      },
    ),
  },
  options: {
    // Shared handlers can read state and signal the waiting exclusive ask handler.
    handlers: {status: {shared: true}, approve: {shared: true}},
  },
});
