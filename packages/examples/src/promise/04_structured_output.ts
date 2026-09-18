// 04: Describe the result with a schema so callers receive validated, typed data.
import * as restate from "@restatedev/restate-sdk";
import {agent} from "@restate-agents/promise";
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

export const promiseTicketTriage = restate.service({
  name: "PromiseTicketTriage",
  handlers: {
    async classify(ctx: restate.Context, message: string) {
      const result = await triage.run(ctx, message);
      return completedOutput(result);
    },
  },
});
