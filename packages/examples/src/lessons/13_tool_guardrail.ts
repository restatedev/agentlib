// 13: Enforce an application budget before a model-requested action runs.
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model, replyText} from "../shared.js";

type BookingContext = {hotelId: string; quotedTotalCents: number; maxTotalCents: number};
const reservationInput = z.object({hotelId: z.string().min(1)});

const bookHotel = asyncTool<typeof reservationInput, BookingContext>({
  description: "Book the quoted demo hotel. The application supplies the authoritative price.",
  input: reservationInput,
  *before({hotelId}, {context}) {
    if (hotelId !== context.hotelId) return "Only the quoted hotel can be booked";
    if (context.quotedTotalCents > context.maxTotalCents)
      return `The total exceeds the $${(context.maxTotalCents / 100).toFixed(2)} budget`;
  },
  async execute({hotelId}, {context}) {
    return {hotelId, totalCents: context.quotedTotalCents, status: "reserved", demo: true};
  },
});

const bookingAgent = agent<BookingContext>({
  model,
  maxSteps: 4,
  instructions:
    "Call bookHotel for the named demo hotel. If the tool refuses, explain that no reservation was made.",
  tools: {bookHotel},
});

export const guardedBooking = restate.service({
  name: "GuardedBooking",
  handlers: {
    ask: restate.schemas(
      {
        input: z.object({
          hotelId: z.string().min(1).default("H-42"),
          quotedTotalCents: z.number().int().positive().default(12500),
          maxTotalCents: z.number().int().positive().default(10000),
        }),
        output: z.string(),
      },
      function* ({hotelId, quotedTotalCents, maxTotalCents}) {
        const question = `Book demo hotel ${hotelId} at the quoted total of $${(quotedTotalCents / 100).toFixed(2)}.`;
        const context = {hotelId, quotedTotalCents, maxTotalCents};
        const result = yield* bookingAgent.run(question, {context});
        return replyText(result);
      },
    ),
  },
});
