// Reimplements restatedev/ai-examples' competitive racing with embedded operations.
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, type Model} from "@restate-agents/core";
import {completedOutput, exampleModel} from "./shared.js";

export function createRacingService(
  models: {quick: Model; thorough: Model} = {
    quick: exampleModel,
    thorough: exampleModel,
  },
) {
  const candidates = {
    quick: agent({
      name: "quick",
      model: models.quick,
      maxSteps: 2,
      instructions: "Quick answer. Give a concise, direct answer to the question.",
    }),
    thorough: agent({
      name: "thorough",
      model: models.thorough,
      maxSteps: 2,
      instructions:
        "Thorough answer. Check assumptions and edge cases, then give a practical answer.",
    }),
  };
  return restate.service({
    name: "RacingAgents",
    handlers: {
      answer: restate.schemas(
        {
          input: z.object({question: z.string().min(1).max(4000)}),
          output: z.object({winner: z.string(), answer: z.string()}),
        },
        function* ({question}) {
          const tasks = Object.entries(candidates).map(([name, candidate]) =>
            restate.spawn(
              (function* () {
                const result = yield* candidate.run(question, {name});
                return {winner: name, answer: completedOutput(result)};
              })(),
            ),
          );
          try {
            // any waits for success: a fast failure must not defeat a healthy peer.
            return yield* restate.any(tasks);
          } catch (error) {
            if (error instanceof AggregateError)
              throw new TerminalError("Neither candidate produced a completed answer");
            throw error;
          } finally {
            // Join after interruption so model AbortSignals and tool cleanup run.
            for (const task of tasks) task.interrupt();
            yield* restate.allSettled(tasks);
          }
        },
      ),
    },
  });
}

export const racingAgents = createRacingService();
