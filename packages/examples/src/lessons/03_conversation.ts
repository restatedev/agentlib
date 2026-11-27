// 03: Keep conversation history between requests to the same object key.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, Conversation} from "@restatedev/agentlib";
import {z} from "zod";
import {openai} from "@ai-sdk/openai";
import {aiModel} from "@restatedev/agentlib/provider";

const model = aiModel({
  model: openai("gpt-5.6-luna"),
  retry: {
    maxAttempts: 3,
    initialInterval: {milliseconds: 500},
    exponentiationFactor: 2,
    maxInterval: {seconds: 5},
  },
});

const assistant = agent({
  model,
  instructions: "Use the conversation to remember what the user told you.",
});

export const chatSession = restate.object({
  name: "ChatSession",
  handlers: {
    ask: restate.schemas(
      {
        input: z.object({
          message: z.string().default("My name is Bob. Remember it for our next conversation."),
        }),
        output: z.string(),
      },
      function* ({message}) {
        // Stores messages in chunks of 8 under `conversation/0`, `conversation/1`, ...,
        // the message count under `conversation/meta`, and the compaction summary under
        // `conversation/summary`. The run loads the conversation before its first
        // model call and saves its progress as it goes.
        const conversation = new Conversation();
        const result = yield* assistant.run(message, {conversation});
        if (result.status !== "completed") return result.output ?? result.reason;
        return result.output;
      },
    ),
    /** Up to 100 saved messages from index `from`, including the ones a summary replaced. */
    *history(from: number) {
      return yield* new Conversation().page(from);
    },
  },
  options: {
    // Every run reads the metadata and the summary, so Restate sends them with the
    // request. The run reads the message chunks after the summary on demand, so a
    // long conversation does not add every message to each request.
    state: {preload: ["conversation/meta", "conversation/summary"]},
    // history reads the conversation while ask runs.
    handlers: {history: {shared: true}},
  },
});
