import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, asyncTool, type AgentUpdate} from "@restate-agents/core";
import {runHandler} from "./replay-harness.mjs";

void test("tool descriptions expose selected parameters without changing execution or replay", async () => {
  let effects = 0;
  let parses = 0;
  const updates: AgentUpdate[] = [];
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
      return request.step === 1
        ? {
            type: "tool_calls",
            calls: [
              {id: "call-1", name: "closeTicket", input: {ticketId: "T-42", reason: "Resolved"}},
            ],
          }
        : {type: "final", text: "Closed"};
    },
    *onUpdate(update) {
      updates.push(update);
    },
  });
  const handler = (context: Context) => r.execute(context, a.run("Close T-42"));
  const live = await runHandler(handler);
  const info = updates.find((update) => update.type === "tool-info");
  assert.ok(info);
  assert.deepEqual(info.info, {name: "Close ticket", details: {ticketId: "T-42"}});
  assert.equal(info.callId, "call-1");
  assert.equal(parses, 1);
  assert.equal(live.output.status, "completed");
  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(effects, 1);
  assert.equal(parses, 2);
});
