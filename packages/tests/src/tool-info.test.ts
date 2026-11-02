import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, asyncTool} from "@restatedev/agentlib";
import {runHandler} from "./replay-harness.mjs";

void test("tool descriptions expose selected parameters without changing execution or replay", async () => {
  let effects = 0;
  let parses = 0;
  const a = agent({
    tools: {
      closeTicket: asyncTool({
        description: "Close a ticket",
        input: z.object({
          ticketId: z.string().transform((value) => {
            parses++;
            return value.trim();
          }),
          reason: z.string(),
        }),
        describe: (input) => {
          const ticketId = input.ticketId;
          input.reason = "Only the description's copy changes";
          return {name: "Close ticket", details: {ticketId}};
        },
        async execute(input) {
          effects++;
          assert.deepEqual(input, {ticketId: "T-42", reason: "Resolved"});
          return {closed: input.ticketId};
        },
      }),
    },
    *model(request) {
      assert.doesNotMatch(JSON.stringify(request), /Close ticket/);
      if (request.step === 1) {
        return {
          type: "tool_calls",
          calls: [
            {id: "call-1", name: "closeTicket", input: {ticketId: " T-42 ", reason: "Resolved"}},
          ],
        };
      }
      return {type: "final", text: "Closed"};
    },
  });
  const handler = (context: Context) => r.execute(context, a.run("Close T-42"));
  const live = await runHandler(handler);
  assert.ok(live.journal.some((entry: Uint8Array) => Buffer.from(entry).includes("Close ticket")));
  assert.equal(parses, 1);
  assert.equal(live.output.status, "completed");
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(effects, 1);
  assert.equal(parses, 2);
});
