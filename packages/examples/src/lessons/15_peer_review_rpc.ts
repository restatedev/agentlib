// 15: Exchange drafts and feedback between agents through typed Restate RPCs.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, awaitChild} from "@restate-agents/core";
import {z} from "zod";
import {completedOutput, exampleModel as model} from "../shared.js";

const brief = z.string().min(1).max(4000);
const draft = z.string().min(1).max(12000);
const reviewFocuses = ["requirements", "clarity"] as const;
const focus = z.enum(reviewFocuses);

const author = agent({
  model,
  maxSteps: 2,
  instructions:
    "Write a concise answer using only facts in the brief. When a draft and feedback are supplied, revise that draft to address both reviews.",
});
const reviewer = agent({
  model,
  maxSteps: 2,
  instructions:
    "Review the draft for the requested focus only. Return one short, actionable suggestion. Check requirements against the brief; do not invent outside facts.",
});

export const peerAuthor = restate.service({
  name: "PeerAuthor",
  handlers: {
    write: restate.schemas(
      {
        input: z.object({
          brief,
          draft: draft.optional(),
          feedback: z.array(z.string().min(1).max(2000)).max(2),
        }),
        output: draft,
      },
      function* (request) {
        const name = request.draft ? "revision" : "first-draft";
        return completedOutput(yield* author.run(JSON.stringify(request), {name}));
      },
    ),
  },
});

export const peerReviewer = restate.service({
  name: "PeerReviewer",
  handlers: {
    review: restate.schemas(
      {input: z.object({brief, draft, focus}), output: z.string().min(1).max(2000)},
      function* (request) {
        return completedOutput(
          yield* reviewer.run(JSON.stringify(request), {name: `review-${request.focus}`}),
        );
      },
    ),
  },
});

export const peerReview = restate.service({
  name: "PeerReview",
  handlers: {
    answer: restate.schemas(
      {
        input: brief.meta({
          default:
            "Write a two-sentence release note for a feature that retries transient failures and resumes completed steps from a journal.",
        }),
        output: draft,
      },
      function* (request) {
        const firstDraft = yield* awaitChild(
          restate.client(peerAuthor).write({brief: request, feedback: []}),
        );
        const reviews = reviewFocuses.map((reviewFocus) =>
          restate.spawn(
            awaitChild(
              restate.client(peerReviewer).review({
                brief: request,
                draft: firstDraft,
                focus: reviewFocus,
              }),
            ),
          ),
        );
        let comments: string[];
        try {
          comments = yield* restate.all(reviews);
        } finally {
          for (const review of reviews) review.interrupt();
          yield* restate.allSettled(reviews);
        }
        const feedback = comments.map((comment, index) => `${reviewFocuses[index]}: ${comment}`);
        return yield* awaitChild(
          restate.client(peerAuthor).write({brief: request, draft: firstDraft, feedback}),
        );
      },
    ),
  },
});
