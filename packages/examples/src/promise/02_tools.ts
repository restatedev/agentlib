// 02: Give the agent one tool, with validated arguments and a journaled result.
import * as restate from "@restatedev/restate-sdk";
import {agent, tool} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const support = agent({
  model,
  instructions: "Use lookupTicket to answer questions about demo tickets.",
  tools: {
    lookupTicket: tool({
      description: "Look up a demo ticket's status.",
      input: z.object({ticketId: z.string()}),
      execute({ticketId}, ctx) {
        // Return the RestatePromise directly; tool callbacks are not async.
        return ctx.run("Look up ticket", () => ({ticketId, status: "open"}));
      },
    }),
  },
});

export const promiseTicketLookup = restate.service({
  name: "PromiseTicketLookup",
  handlers: {
    async ask(ctx: restate.Context, message: string) {
      return await support.run(ctx, message);
    },
  },
});
