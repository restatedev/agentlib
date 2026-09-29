// 18: Serve an agent to AG-UI clients, such as CopilotKit.
//
// AG-UI (https://docs.ag-ui.com) streams an agent run to a UI as server-sent
// events. Here the agent runs in a Restate object, one per AG-UI thread, and
// appends the AG-UI events of its work to the object's state. The HTTP handler
// at the bottom only reads them. So closing the stream does not stop the turn,
// and an approval ends the AG-UI run with an interrupt while the turn waits on
// a durable signal, holding no process, until a resume run answers it.
import type {IncomingMessage, ServerResponse} from "node:http";
import {setTimeout as delay} from "node:timers/promises";
import {EventType, type Event, type Interrupt} from "@ag-ui/core";
import {RunAgentInputSchema} from "@ag-ui/core/schemas";
import {TerminalError} from "@restatedev/restate-sdk";
import {connect} from "@restatedev/restate-sdk-clients";
import * as restate from "@restatedev/restate-sdk-gen";
import {agent, asyncTool, type Message, type ProgressEvent} from "@restate-agents/core";
import {z} from "zod";
import {exampleModel as model} from "../shared.js";

const assistant = agent({
  model,
  instructions:
    "AG-UI lesson. Use lookupOrder to answer questions about demo orders. Use cancelOrder to cancel one; a person approves each cancellation.",
  tools: {
    lookupOrder: asyncTool({
      description: "Look up a demo order.",
      input: z.object({orderId: z.string().min(1)}),
      async execute({orderId}) {
        return {orderId, status: "shipped"};
      },
    }),
    cancelOrder: asyncTool({
      description: "Cancel a demo order after a person approves. No real order changes.",
      input: z.object({orderId: z.string().min(1)}),
      needsApproval: true,
      async execute({orderId}) {
        return {orderId, status: "cancelled"};
      },
    }),
  },
});

/** The thread's log: AG-UI events, plus the markers the HTTP handler turns into runs. */
type Entry =
  | Event
  | {type: "turn"; runId: string}
  | {type: "interrupt"; interrupt: Interrupt}
  | {type: "done"}
  | {type: "failed"; message: string};
/** An approval the turn waits for, and where a resume continues reading. */
type Pending = {invocationId: string; signalName: string; cursor: number};

/** The AG-UI events that show a progress event; the others have no counterpart here. */
function progressEvents(event: ProgressEvent): Event[] {
  if (event.type === "tool-start")
    return [
      {type: EventType.TOOL_CALL_START, toolCallId: event.callId, toolCallName: event.name},
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.callId,
        delta: JSON.stringify(event.input),
      },
      {type: EventType.TOOL_CALL_END, toolCallId: event.callId},
    ];
  if (event.type === "tool-end")
    return [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${event.callId}-result`,
        toolCallId: event.callId,
        // JSON, because clients such as CopilotKit parse a tool result as JSON.
        content: JSON.stringify(event.result),
      },
    ];
  return [];
}

export const agUiThread = restate.object({
  name: "AgUiThread",
  handlers: {
    turn: restate.schemas(
      {
        input: z.object({
          runId: z.string().min(1).default("run-1"),
          message: z.string().min(1).default("Cancel order O-7."),
        }),
        output: z.void(),
      },
      function* ({runId, message}) {
        const state = restate.state();
        let count = (yield* state.get<number>("count")) ?? 0;
        const append = (...entries: Entry[]) => {
          for (const entry of entries) state.set(`entry-${count++}`, entry);
          state.set("count", count);
        };
        // Turns queue on the object, so each marks where its own events start.
        append({type: "turn", runId});
        const pending: Record<string, Pending> = {};
        try {
          const result = yield* assistant.run(message, {
            messages: (yield* state.get<Message[]>("messages")) ?? [],
            *onProgress(event) {
              append(...progressEvents(event));
              if (event.type === "tool-end" && event.callId in pending) {
                delete pending[event.callId];
                state.set("pending", pending);
              }
            },
            *onApproval({invocationId, signalName, call}) {
              // A resume reads on right after the interrupt, so it also gets
              // what the turn appended while no stream was open.
              pending[call.id] = {invocationId, signalName, cursor: count + 1};
              state.set("pending", pending);
              append({
                type: "interrupt",
                interrupt: {
                  id: call.id,
                  reason: "tool_approval",
                  toolCallId: call.id,
                  message: `Allow ${call.name} with ${JSON.stringify(call.input)}?`,
                  responseSchema: {
                    type: "object",
                    properties: {approved: {type: "boolean"}},
                    required: ["approved"],
                  },
                },
              });
            },
          });
          state.set("messages", result.messages);
          const text = result.status === "completed" ? result.output : (result.output ?? "");
          const messageId = `${restate.handlerRequest().id}-answer`;
          append(
            {type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant"},
            // A content event must carry a non-empty delta.
            ...(text
              ? [{type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text} as const]
              : []),
            {type: EventType.TEXT_MESSAGE_END, messageId},
            {type: "done"},
          );
        } catch (error) {
          if (!(error instanceof TerminalError)) throw error;
          append({type: "failed", message: error.message});
        } finally {
          state.clear("pending");
        }
      },
    ),
    *count() {
      return (yield* restate.sharedState().get<number>("count")) ?? 0;
    },
    /** Up to 100 entries, starting at `after`. */
    *read(after: number) {
      const state = restate.sharedState();
      const end = Math.min((yield* state.get<number>("count")) ?? 0, after + 100);
      const entries: Entry[] = [];
      for (let i = after; i < end; i++) entries.push((yield* state.get<Entry>(`entry-${i}`))!);
      return entries;
    },
    /** Answers an interrupt and returns where the resumed run reads on. */
    *answer({interruptId, approved}: {interruptId: string; approved: boolean}) {
      const pending = yield* restate.sharedState().get<Record<string, Pending>>("pending");
      const waiting = pending?.[interruptId];
      if (!waiting)
        throw new TerminalError(`Interrupt ${interruptId} is not waiting for an answer`);
      restate.invocation(waiting.invocationId).signal(waiting.signalName).resolve(approved);
      return waiting.cursor;
    },
  },
  // Shared handlers read and answer while a turn runs.
  options: {handlers: {count: {shared: true}, read: {shared: true}, answer: {shared: true}}},
});

/**
 * AG-UI's HTTP transport as a Node request handler: POST a RunAgentInput, read
 * the run as server-sent events. A run with `resume` answers the interrupt
 * that ended the previous run; any other run sends the last user message as a
 * new turn. Each run follows its turn until the turn answers or asks for approval.
 */
export function agUiHandler(ingressUrl: string) {
  const ingress = connect({url: ingressUrl});
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const parsed = RunAgentInputSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      response.writeHead(400).end("Expected an AG-UI RunAgentInput");
      return;
    }
    const {threadId, runId, messages, resume} = parsed.data;
    const thread = ingress.client(agUiThread, threadId);
    let closed = false;
    response.on("close", () => (closed = true));
    response.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-store"});
    const send = (event: Event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({type: EventType.RUN_STARTED, threadId, runId});
    try {
      let cursor: number;
      let following = false;
      const answer = resume?.[0];
      if (answer) {
        const approved = answer.status === "resolved" && answer.payload?.approved === true;
        cursor = await thread.answer({interruptId: answer.interruptId, approved});
        following = true;
      } else {
        const last = messages.at(-1);
        if (last?.role !== "user" || typeof last.content !== "string")
          throw new Error("The last message must be the user's text");
        cursor = await thread.count();
        await ingress.sendClient(agUiThread, threadId).turn({runId, message: last.content});
      }
      // The state is the source of truth, so polling it is enough for a lesson.
      while (!closed) {
        const entries = await thread.read(cursor);
        if (!entries.length) await delay(200);
        cursor += entries.length;
        for (const entry of entries) {
          if (entry.type === "turn") following ||= entry.runId === runId;
          else if (!following) continue;
          else if (entry.type === "interrupt")
            return send({
              type: EventType.RUN_FINISHED,
              threadId,
              runId,
              outcome: {type: "interrupt", interrupts: [entry.interrupt]},
            });
          else if (entry.type === "done")
            return send({
              type: EventType.RUN_FINISHED,
              threadId,
              runId,
              outcome: {type: "success"},
            });
          else if (entry.type === "failed")
            return send({type: EventType.RUN_ERROR, message: entry.message});
          else send(entry);
        }
      }
    } catch (error) {
      send({
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      response.end();
    }
  }
  return (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch(() => response.destroy());
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return undefined;
  }
}
