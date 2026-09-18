// 02: Give the agent one tool, with validated arguments and a journaled result.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, tool} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const support = agent({
  model,
  instructions: "Use lookupTicket to answer questions about demo tickets.",
  tools: {
    lookupTicket: tool({
      description: "Look up a demo ticket's status.",
      input: z.object({ticketId: z.string()}),
      *execute({ticketId}) {
        // Replace the fixed record with I/O inside restate.run.
        return yield* restate.run(async () => ({ticketId, status: "open"}), {
          name: "Look up ticket",
        });
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
