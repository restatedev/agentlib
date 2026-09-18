// 03: Keep conversation history between requests to the same object key.
import * as restate from "@restatedev/restate-sdk";
import {agent, type Message} from "@restate-agents/promise";
import {exampleModel as model} from "../shared.js";

const assistant = agent({
  model,
  instructions: "Use the conversation to remember what the user told you.",
});

export const promiseChatSession = restate.object({
  name: "PromiseChatSession",
  handlers: {
    async ask(ctx: restate.ObjectContext, message: string) {
      const messages = (await ctx.get<Message[]>("messages")) ?? [];
      const result = await assistant.run(ctx, message, {messages});
      ctx.set("messages", result.messages);
      return result;
    },
  },
});
