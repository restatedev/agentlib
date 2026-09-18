// 04: Describe the result with a schema so callers receive validated, typed data.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restate-agents/core";
import {z} from "zod";
import {completedOutput, exampleModel as model} from "../shared.js";

const classificationSchema = z.object({
  category: z.enum(["billing", "technical", "other"]),
  summary: z.string(),
});

const triage = agent({
  model,
  instructions: "Classify the support request and summarize it in one sentence.",
  output: classificationSchema,
});

export const ticketTriage = restate.service({
  name: "TicketTriage",
  handlers: {
    classify: restate.schemas(
      {
        input: z
          .string()
          .min(1)
          .meta({default: "I was charged twice for my subscription. Please help me get a refund."}),
        output: classificationSchema,
      },
      function* (message) {
        const result = yield* triage.run(message);
        return completedOutput(result);
      },
    ),
  },
});
