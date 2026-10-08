import {createAmazonBedrock} from "@ai-sdk/amazon-bedrock";
import {createAnthropic} from "@ai-sdk/anthropic";
import type {Model} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {aiModel} from "@restate-agents/core/provider";

const retry = {
  maxAttempts: 3,
  initialInterval: {milliseconds: 500},
  exponentiationFactor: 2,
  maxInterval: {seconds: 5},
};

/**
 * The model AGENT_MODEL names: "anthropic:<model>", "bedrock:<model>", or an
 * OpenAI model with an optional "openai:" prefix. The OpenAI adapter speaks
 * Chat Completions, so with OPENAI_BASE_URL it also reaches compatible servers,
 * such as DeepSeek, xAI, OpenRouter, Ollama or vLLM. Every provider reads its
 * credentials when a call is made: importing the examples needs none.
 */
function modelFrom(id: string): Model {
  // Only a known prefix names a provider; "llama3.1:8b" is a model on its own.
  const [, provider = "openai", name = id] = /^(openai|anthropic|bedrock):(.+)$/.exec(id) ?? [];
  if (provider === "anthropic") return aiModel({model: createAnthropic()(name), retry});
  if (provider === "bedrock") return aiModel({model: createAmazonBedrock()(name), retry});
  return openAIModel({model: name, retry});
}

export const exampleModel = modelFrom(process.env.AGENT_MODEL || "gpt-5.6-luna");
