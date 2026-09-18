// 01: Run an agent inside a Restate handler. Each request starts a fresh conversation.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restate-agents/core";
import {exampleModel as model} from "../shared.js";

const assistant = agent({model});

export const hello = restate.service({
  name: "Hello",
  handlers: {
    *ask(message: string) {
      return yield* assistant.run(message);
    },
  },
});
