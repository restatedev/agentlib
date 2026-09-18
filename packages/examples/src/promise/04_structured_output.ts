// 04: Describe the result with a schema so callers receive validated, typed data.
import * as restate from "@restatedev/restate-sdk";
import {agent} from "@restate-agents/promise";
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

export const promiseTicketTriage = restate.service({
  name: "PromiseTicketTriage",
  handlers: {
    classify: restate.createServiceHandler(
      {
        input: restate.serde.schema(
          z.string().min(1).meta({
            default: "I was charged twice for my subscription. Please help me get a refund.",
          }),
        ),
        output: restate.serde.schema(classificationSchema),
      },
      async (ctx, message) => {
        const result = await triage.run(ctx, message);
        return completedOutput(result);
      },
    ),
  },
});
