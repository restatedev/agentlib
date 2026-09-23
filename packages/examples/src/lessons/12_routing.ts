// 12: Use a structured decision to route a request to one specialist.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restate-agents/core";
import {z} from "zod";
import {completedOutput, exampleModel as model, replyText} from "../shared.js";

const route = agent({
  model,
  maxSteps: 2,
  instructions:
    "Choose the one specialist best suited to answer the customer question. Classify only; do not answer it.",
  output: z.object({specialist: z.enum(["billing", "account", "product"])}),
});

const specialists = {
  billing: agent({
    model,
    instructions:
      "Help with payments, charges, and refunds. Do not claim to have changed an order.",
  }),
  account: agent({
    model,
    instructions: "Help with sign-in and account access. Never ask for a password.",
  }),
  product: agent({
    model,
    instructions: "Explain product features and how to use them. Admit when details are unknown.",
  }),
};

export const supportRouter = restate.service({
  name: "SupportRouter",
  handlers: {
    answer: restate.schemas(
      {
        input: z
          .string()
          .min(1)
          .meta({default: "I can't log into my account. How can I regain access?"}),
        output: z.string(),
      },
      function* (question) {
        const {specialist} = completedOutput(yield* route.run(question));
        const result = yield* specialists[specialist].run(question);
        return replyText(result);
      },
    ),
  },
});
