// 02: Give the agent one tool, with validated arguments and a journaled result.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const support = agent({
  model,
  instructions: "Use lookupTicket to answer questions about demo tickets.",
  tools: {
    lookupTicket: asyncTool({
      description: "Look up a demo ticket's status.",
      input: z.object({ticketId: z.string()}),
      describe: {name: "Look up ticket"},
      async execute({ticketId}) {
        // Replace this demo record with an ordinary async API call.
        return {ticketId, status: "open"};
      },
    }),
  },
});

export const ticketLookup = restate.service({
  name: "TicketLookup",
  handlers: {
    *ask(message: string) {
      return yield* support.run(message);
    },
  },
});
