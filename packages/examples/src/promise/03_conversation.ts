// 03: Keep conversation history between requests to the same object key.
import * as restate from "@restatedev/restate-sdk";
import {agent, type Message} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

const assistant = agent({
  model,
  instructions: "Use the conversation to remember what the user told you.",
});

export const promiseChatSession = restate.object({
  name: "PromiseChatSession",
  handlers: {
    ask: restate.createObjectHandler(
      {
        input: restate.serde.schema(
          z
            .string()
            .min(1)
            .meta({default: "My name is Bob. Remember it for our next conversation."}),
        ),
        output: restate.serde.schema(z.string()),
      },
      async (ctx, message) => {
        const messages = (await ctx.get<Message[]>("messages")) ?? [];
        const result = await assistant.run(ctx, message, {messages});
        ctx.set("messages", result.messages);
        return replyText(result);
      },
    ),
  },
});
