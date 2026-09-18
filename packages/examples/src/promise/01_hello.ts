// 01: Run an agent inside a Restate handler. Each request starts a fresh conversation.
import * as restate from "@restatedev/restate-sdk";
import {agent} from "@restate-agents/promise";
import {exampleModel as model} from "../shared.js";

const assistant = agent({model});

export const promiseHello = restate.service({
  name: "PromiseHello",
  handlers: {
    async ask(ctx: restate.Context, message: string) {
      return await assistant.run(ctx, message);
    },
  },
});
