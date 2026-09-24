// 06: Pause a tool for a human decision, then resume the same agent run.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool, type ApprovalRequest} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const support = agent({
  model,
  instructions:
    "Ticket approval lesson. Use closeTicket to close the requested demo ticket. If approval is denied, explain that the ticket was left unchanged and do not try again.",
  tools: {
    closeTicket: asyncTool({
      description: "Close a demo ticket after human approval. No external ticket is changed.",
      input: z.object({ticketId: z.string().min(1)}),
      needsApproval: true,
      async execute({ticketId}) {
        // Replace this demo result with an ordinary async API call.
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
        try {
          const result = yield* support.run(message, {
            *onApproval(request) {
              restate.state().set("approval", request);
            },
          });
          if (result.status !== "completed") return result.output ?? result.reason;
          return result.output;
        } finally {
          // A failed run must not leave a request that nobody is waiting for.
          restate.state().clear("approval");
        }
      },
    ),
    *status() {
      return yield* restate.sharedState().get<ApprovalRequest>("approval");
    },
    approve: restate.schemas(
      {
        input: z.object({
          invocationId: z.string().min(1).describe("Copy invocationId from status()."),
          signalName: z.string().min(1).describe("Copy signalName from the same approval request."),
          approved: z.boolean().default(false),
        }),
        output: z.boolean(),
      },
      function* ({invocationId, signalName, approved}) {
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
