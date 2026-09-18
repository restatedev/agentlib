// 02: Give the agent one tool, with validated arguments and a journaled result.
import * as restate from "@restatedev/restate-sdk";
import {agent, asyncTool} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

const support = agent({
  model,
  instructions: "Use lookupTicket to answer questions about demo tickets.",
  tools: {
    lookupTicket: asyncTool({
      description: "Look up a demo ticket's status.",
      input: z.object({ticketId: z.string()}),
      describe: {name: "Look up ticket"},
      retry: {
        maxAttempts: 5, // Includes the initial attempt.
        initialInterval: {milliseconds: 250},
        exponentiationFactor: 2,
        maxInterval: {seconds: 5},
        maxDuration: {seconds: 30},
      },
      async execute({ticketId}) {
        // Replace this demo record with an ordinary async API call.
        return {ticketId, status: "open"};
      },
    }),
  },
});

export const promiseTicketLookup = restate.service({
  name: "PromiseTicketLookup",
  handlers: {
    async ask(ctx: restate.Context, message: string) {
      const result = await support.run(ctx, message);
      return replyText(result);
    },
  },
});
