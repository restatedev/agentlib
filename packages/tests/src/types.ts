import {agent, tool, type ToolContext, type Model} from "@restate-agents/core";
import {z} from "zod";

// Compile-only examples verify the public type boundary.
const model: Model = function* () {
  return {type: "final", text: "Done"};
};
const a = agent<{tenant: string}>({
  model,
  tools: {
    lookup: tool({
      input: z.object({id: z.string()}),
      description: "Lookup",
      *execute(input, ctx: ToolContext<{tenant: string}>) {
        const id: string = input.id;
        // @ts-expect-error The schema infers string, not number.
        const wrong: number = input.id;
        void wrong;
        return {id, tenant: ctx.context.tenant};
      },
    }),
  },
});
a.run("Go", {context: {tenant: "a"}});
// @ts-expect-error A typed context is required on each run.
a.run("Go");
// @ts-expect-error Context fields are checked.
a.run("Go", {context: {tenant: 3}});
agent({model}).run("Go");
