// 04: Describe the result with a schema so callers receive validated, typed data.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restate-agents/core";
import {z} from "zod";
import {completedOutput, exampleModel as model} from "../shared.js";

const triage = agent({
  model,
  instructions: "Classify the support request and summarize it in one sentence.",
  output: z.object({
    category: z.enum(["billing", "technical", "other"]),
    summary: z.string(),
  }),
});

export const ticketTriage = restate.service({
  name: "TicketTriage",
  handlers: {
    *classify(message: string) {
      const result = yield* triage.run(message);
      return completedOutput(result);
    },
  },
});
