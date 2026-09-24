// 16: Publish an agent's progress to a feed that clients can follow.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, tool, type ProgressEvent} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

type FeedMessage = ProgressEvent | {type: "done"; reply: string};
type Subscriber = {awakeable: string; after: number};

/** A pub/sub feed, one per key. Messages are kept in order; subscribers read from an offset. */
export const progressFeed = restate.object({
  name: "ProgressFeed",
  handlers: {
    *publish(message: FeedMessage) {
      const messages = (yield* restate.state().get<FeedMessage[]>("messages")) ?? [];
      messages.push(message);
      restate.state().set("messages", messages);
      // Wake everyone waiting for new messages; each gets what it has not seen.
      const subscribers = (yield* restate.state().get<Subscriber[]>("subscribers")) ?? [];
      for (const {awakeable, after} of subscribers)
        restate.resolveAwakeable(awakeable, messages.slice(after));
      restate.state().clear("subscribers");
    },
    /** Called by subscribe; exclusive, so no message can slip in between the check and the wait. */
    *wait(subscriber: Subscriber) {
      const messages = (yield* restate.state().get<FeedMessage[]>("messages")) ?? [];
      if (messages.length > subscriber.after) {
        restate.resolveAwakeable(subscriber.awakeable, messages.slice(subscriber.after));
        return;
      }
      const subscribers = (yield* restate.state().get<Subscriber[]>("subscribers")) ?? [];
      subscribers.push(subscriber);
      restate.state().set("subscribers", subscribers);
    },
    /** Returns the messages after `after`, waiting until there is at least one. */
    *subscribe({after}: {after: number}) {
      const messages = (yield* restate.sharedState().get<FeedMessage[]>("messages")) ?? [];
      if (messages.length > after) return messages.slice(after);
      const {id, promise} = restate.awakeable<FeedMessage[]>();
      restate.sendClient(progressFeed, restate.handlerRequest().key!).wait({awakeable: id, after});
      return yield* promise;
    },
  },
  options: {
    // A subscriber waits without holding the feed's lock, so publishing continues.
    handlers: {subscribe: {shared: true}},
  },
});

const auditor = agent({
  model,
  instructions:
    "Audit stock. Count the requested warehouses with countStock, then name the one with the least stock.",
  tools: {
    countStock: tool({
      description: "Count stock in demo warehouses. No inventory system is called.",
      input: z.object({warehouses: z.array(z.string().min(1)).min(1).max(10)}),
      *execute({warehouses}, context) {
        const counts: Record<string, number> = {};
        for (const [index, warehouse] of warehouses.entries()) {
          // Replace this demo count with a call to an inventory API.
          counts[warehouse] = yield* restate.run(async () => warehouse.length * 7, {
            name: `count ${warehouse}`,
          });
          yield* context.progress({counted: index + 1, of: warehouses.length});
        }
        return counts;
      },
    }),
  },
});

export const inventoryAudit = restate.service({
  name: "InventoryAudit",
  handlers: {
    audit: restate.schemas(
      {
        input: z.object({
          job: z.string().min(1).default("audit-1"),
          request: z
            .string()
            .min(1)
            .default("Count stock in Berlin, Lisbon, and Oslo, then name the lowest one."),
        }),
        output: z.string(),
      },
      function* ({job, request}) {
        const feed = restate.sendClient(progressFeed, job);
        const result = yield* auditor.run(request, {
          // A one-way send: the run continues without waiting for the feed.
          *onProgress(event) {
            feed.publish(event);
          },
        });
        const reply = replyText(result);
        feed.publish({type: "done", reply});
        return reply;
      },
    ),
  },
});
