// 03: Keep conversation history between requests to the same object key.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, type Message} from "@restate-agents/core";
import {exampleModel as model, replyText} from "../shared.js";

const assistant = agent({
  model,
  instructions: "Use the conversation to remember what the user told you.",
});

export const chatSession = restate.object({
  name: "ChatSession",
  handlers: {
    *ask(message: string) {
      const messages = (yield* restate.state().get<Message[]>("messages")) ?? [];
      const result = yield* assistant.run(message, {messages});
      restate.state().set("messages", result.messages);
      return replyText(result);
    },
  },
});
