// 01: Run an agent inside a Restate handler. Each request starts a fresh conversation.
import * as restate from "@restatedev/restate-sdk";
import {agent} from "@restate-agents/promise";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

const assistant = agent({model});

export const promiseHello = restate.service({
  name: "PromiseHello",
  handlers: {
    ask: restate.createServiceHandler(
      {
        input: restate.serde.schema(
          z.string().min(1).meta({default: "Say hello in one sentence."}),
        ),
        output: restate.serde.schema(z.string()),
      },
      async (ctx, message) => {
        const result = await assistant.run(ctx, message);
        return replyText(result);
      },
    ),
  },
});
