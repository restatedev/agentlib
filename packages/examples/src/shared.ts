import {openAIModel} from "@restate-agents/core/openai";

// Construction is lazy: importing the examples needs no provider credentials.
export const exampleModel = openAIModel({
  model: process.env.AGENT_MODEL ?? "gpt-5.6-luna",
  retry: {
    maxAttempts: 3,
    initialInterval: {milliseconds: 500},
    exponentiationFactor: 2,
    maxInterval: {seconds: 5},
  },
});
