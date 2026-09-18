import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  agent,
  cancelOperationTool,
  handoff,
  LazyStateConversation,
  searchToolsTool,
  sleepTool,
  tool,
  type AgentUpdate,
  type ApprovalRequest,
} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";
import {mcpTools} from "@restate-agents/core/mcp";
import {programTool} from "@restate-agents/core/program";

type SessionContext = {sessionKey: string};
const model = openAIModel({model: process.env.AGENT_MODEL ?? "gpt-5.6-luna"});
const lookupTicket = tool({
  description:
    "Look up a demo support ticket. This example does not connect to a ticketing system.",
  input: z.object({ticket: z.string().min(1)}),
  deferred: true,
  provider: "support",
  *execute({ticket}, {context}: import("@restate-agents/core").ToolContext<SessionContext>) {
    return yield* restate.run(async () => ({ticket, status: "open", session: context.sessionKey}), {
      name: "demo-ticket",
    });
  },
});
const closeTicket = tool({
  description: "Close a demo ticket after human approval. No external ticket is changed.",
  input: z.object({ticket: z.string().min(1)}),
  needsApproval: true,
  *before({ticket}) {
    return ticket !== "locked" || "The locked ticket cannot be changed";
  },
  *execute({ticket}, context) {
    return yield* restate.run(
      async () => ({
        ticket,
        status: "closed",
        demo: true,
        idempotencyKey: `${context.invocationId}:${context.callId}`,
      }),
      {name: "demo-close-ticket"},
    );
  },
});
const resolution = agent<SessionContext>({
  name: "resolution",
  model,
  tools: {lookupTicket, closeTicket, searchTools: searchToolsTool()},
  instructions:
    "Resolve the support ticket. Tool policies require approval before closing a ticket.",
});
const support = agent<SessionContext>({
  name: "support",
  model,
  finalize: model,
  maxSteps: 12,
  instructions:
    "Help with the user's task. Search for unfamiliar tools. Use the program tool for parallel data processing. Transfer ticket resolution to the specialist. Inspect background outcomes before finishing.",
  tools: {
    lookupTicket,
    searchTools: searchToolsTool(),
    program: programTool(),
    sleep: sleepTool(),
    cancelOperation: cancelOperationTool(),
    resolution: handoff(resolution),
  },
});

/** Application-owned session and control surface; none of this is required by the SDK. */
export const aiSession = restate.object({
  name: "AiSession",
  handlers: {
    doTurn: restate.schemas(
      {input: z.object({message: z.string().min(1)}), output: z.json()},
      function* ({message}) {
        const invocationId = restate.handlerRequest().id;
        const context = {sessionKey: restate.handlerRequest().key!};
        const conversation = new LazyStateConversation({
          compaction: {model, policy: {maxMessages: 64, retainMessages: 12}},
        });
        const approvals = new Map<string, ApprovalRequest>();
        const updates: AgentUpdate[] = [];
        restate.state().set("active", {invocationId});
        let remote:
          | {
              tools: Record<string, import("@restate-agents/core").Tool<SessionContext>>;
              close(): restate.Operation<void>;
            }
          | undefined;
        try {
          if (process.env.MCP_SERVER_URL)
            remote = yield* mcpTools<SessionContext>({
              url: process.env.MCP_SERVER_URL,
              namespace: "remote",
              protocol: process.env.MCP_PROTOCOL === "stateful" ? "stateful" : "stateless",
              *token() {
                return process.env.MCP_TOKEN;
              },
            });
          return yield* support.run(message, {
            context,
            conversation,
            tools: remote?.tools,
            steeringSignal: "steering",
            interruptSignal: "interrupt",
            *onUpdate(update) {
              if (update.type === "approval-required")
                approvals.set(update.request.signalName, update.request);
              if (update.type === "tool-end")
                for (const [name, request] of approvals)
                  if (request.call.id === update.call.id) approvals.delete(name);
              updates.push(update);
              if (updates.length > 128) updates.shift();
              restate.state().set("approvals", [...approvals.values()]);
              restate.state().set("updates", updates);
            },
          });
        } finally {
          restate.state().clear("active");
          restate.state().clear("approvals");
          if (remote) yield* remote.close();
        }
      },
    ),
    *status() {
      return {
        active: yield* restate.sharedState().get("active"),
        approvals: (yield* restate.sharedState().get("approvals")) ?? [],
        updates: (yield* restate.sharedState().get("updates")) ?? [],
      };
    },
    *history() {
      return yield* new LazyStateConversation().page();
    },
    *steer(message: string) {
      const active = yield* restate.sharedState().get<{invocationId: string}>("active");
      if (!active) return false;
      restate.invocation(active.invocationId).signal("steering").resolve(message);
      return true;
    },
    *interrupt(reason: string) {
      const active = yield* restate.sharedState().get<{invocationId: string}>("active");
      if (!active) return false;
      restate.invocation(active.invocationId).signal("interrupt").resolve(reason);
      return true;
    },
    *approve(input: {signalName: string; approved: boolean}) {
      const active = yield* restate.sharedState().get<{invocationId: string}>("active");
      const requests = (yield* restate.sharedState().get<ApprovalRequest[]>("approvals")) ?? [];
      if (!active || !requests.some((request) => request.signalName === input.signalName))
        return false;
      restate.invocation(active.invocationId).signal(input.signalName).resolve(input.approved);
      return true;
    },
  },
  options: {
    handlers: {
      status: {shared: true},
      history: {shared: true},
      steer: {shared: true},
      interrupt: {shared: true},
      approve: {shared: true},
    },
  },
});
