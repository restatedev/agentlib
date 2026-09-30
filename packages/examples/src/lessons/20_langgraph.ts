// 20: Run a LangGraph.js graph on Restate, keeping LangGraph's API.
//
// LangGraph checkpoints between nodes, so a node that fails halfway re-runs
// from its start, and `interrupt()` re-runs its node on resume. Here the graph
// runs inside a Restate handler instead, and three small adapters journal the
// work inside the nodes:
//
// - `durableModel` journals each model call, so a retry or replay reuses it.
// - `durableTool` journals each tool call as one step.
// - `waitForHuman` suspends on a durable promise; the node continues where it
//   waited, with nothing before it repeated, and no process is held meanwhile.
//
// The graph itself is plain LangGraph: a StateGraph over MessagesAnnotation,
// a model node, a ToolNode and conditional edges. It needs no checkpointer:
// the handler's journal is the checkpoint, and the object keeps the thread.
// The adapters are the lesson's own code, not an SDK API.
import {AsyncLocalStorage} from "node:async_hooks";
import {randomUUID} from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type {BaseLanguageModelInput} from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type AIMessageChunk,
  type BaseMessage,
  type StoredMessage,
} from "@langchain/core/messages";
import type {ChatResult} from "@langchain/core/outputs";
import type {Runnable} from "@langchain/core/runnables";
import {tool, type StructuredToolInterface} from "@langchain/core/tools";
import {END, MessagesAnnotation, START, StateGraph} from "@langchain/langgraph";
import {ToolNode} from "@langchain/langgraph/prebuilt";
import {ChatOpenAI} from "@langchain/openai";
import {z} from "zod";

// ---- The adapters ----

const current = new AsyncLocalStorage<restate.ObjectContext>();

/** The Restate context of the handler running the graph. */
function restateContext() {
  const ctx = current.getStore();
  if (!ctx) throw new Error("Run the graph through runGraph, inside a Restate handler");
  return ctx;
}

/**
 * Invokes a graph inside a Restate handler. Nodes run one at a time: the
 * journal must record the same order on every replay, and parallel nodes with
 * several journaled steps each would interleave by timing.
 */
function runGraph<T>(
  ctx: restate.ObjectContext,
  invoke: (config: {maxConcurrency: number}) => Promise<T>,
) {
  return current.run(ctx, () => invoke({maxConcurrency: 1}));
}

type ChatRunnable = Runnable<BaseLanguageModelInput, AIMessageChunk>;

/** A chat model whose calls are journaled. `bindTools` and structured output keep working. */
class DurableChatModel extends BaseChatModel {
  constructor(private readonly inner: () => BaseChatModel | ChatRunnable) {
    super({});
  }
  _llmType() {
    return "restate-durable";
  }
  override bindTools(tools: BindToolsInput[], kwargs?: Partial<BaseChatModelCallOptions>) {
    return new DurableChatModel(() => {
      const model = this.inner() as BaseChatModel;
      return model.bindTools!(tools, kwargs) as ChatRunnable;
    });
  }
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    // Restate owns retries, so the inner model should not retry on its own.
    const stored = await restateContext().run(
      "model",
      async () => {
        const reply = await this.inner().invoke(messages, {signal: options.signal});
        const [stored] = mapChatMessagesToStoredMessages([reply]);
        // An ID made here is journaled with the reply, so replay sees the same one.
        return {...stored!, data: {...stored!.data, id: reply.id ?? randomUUID()}};
      },
      {maxRetryAttempts: 3},
    );
    const message = mapStoredMessagesToChatMessages([stored])[0]!;
    return {generations: [{message, text: message.text}]};
  }
}

/** Wraps a chat model, built lazily so importing the graph needs no credentials. */
function durableModel(model: () => BaseChatModel) {
  let built: BaseChatModel | undefined;
  return new DurableChatModel(() => (built ??= model()));
}

/**
 * A tool whose call is journaled as one step. ToolNode runs a message's tool
 * calls in parallel; with one journaled step each, their order in the journal
 * does not depend on which finishes first.
 */
function durableTool(inner: StructuredToolInterface) {
  return tool(
    (input) => restateContext().run(inner.name, async () => (await inner.invoke(input)) as unknown),
    {name: inner.name, description: inner.description, schema: inner.schema},
  );
}

/** Like LangGraph's interrupt(): waits for an answer, but the node does not re-run on resume. */
async function waitForHuman<T>(question: unknown): Promise<T> {
  const ctx = restateContext();
  const {id, promise} = ctx.awakeable<T>();
  ctx.set("pending", {id, question});
  const answer = await promise;
  ctx.clear("pending");
  return answer;
}

// ---- A LangGraph graph ----

const lookupOrder = durableTool(
  tool(async ({orderId}) => ({orderId, status: "delivered", totalCents: 4000}), {
    name: "lookupOrder",
    description: "Look up a demo order.",
    schema: z.object({orderId: z.string()}),
  }),
);
const refundOrder = durableTool(
  tool(async ({orderId}) => ({orderId, refunded: true}), {
    name: "refundOrder",
    description: "Refund a demo order. A person approves each refund. No real order changes.",
    schema: z.object({orderId: z.string()}),
  }),
);
const tools = [lookupOrder, refundOrder];

const model = durableModel(
  () => new ChatOpenAI({model: process.env.AGENT_MODEL ?? "gpt-5.6-luna", maxRetries: 0}),
).bindTools(tools);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async ({messages}) => ({
    messages: [
      await model.invoke([
        {
          role: "system",
          content:
            "LangGraph lesson. Help with demo orders. Use lookupOrder, then refundOrder when a refund is asked for.",
        },
        ...messages,
      ]),
    ],
  }))
  // Review refunds before the tools run, the usual LangGraph human-in-the-loop shape.
  .addNode("review", async ({messages}) => {
    const request = messages.at(-1) as AIMessage;
    const refunds = request.tool_calls!.filter((call) => call.name === "refundOrder");
    const approved = await waitForHuman<boolean>({refunds: refunds.map((call) => call.args)});
    if (approved) return {};
    const denied = refunds.map(
      (call) =>
        new ToolMessage({
          tool_call_id: call.id!,
          name: call.name,
          content: "A person denied the refund.",
        }),
    );
    // Answer the other calls too, so every tool call keeps its result.
    const others = request.tool_calls!.filter((call) => call.name !== "refundOrder");
    return {
      messages: [
        ...denied,
        ...others.map(
          (call) =>
            new ToolMessage({
              tool_call_id: call.id!,
              name: call.name,
              content: "Skipped with the refund.",
            }),
        ),
      ],
    };
  })
  .addNode("tools", new ToolNode(tools))
  .addEdge(START, "agent")
  .addConditionalEdges("agent", ({messages}) => {
    const calls = (messages.at(-1) as AIMessage).tool_calls ?? [];
    if (calls.length === 0) return END;
    return calls.some((call) => call.name === "refundOrder") ? "review" : "tools";
  })
  .addConditionalEdges("review", ({messages}) =>
    messages.at(-1) instanceof ToolMessage ? "agent" : "tools",
  )
  .addEdge("tools", "agent")
  .compile();

// ---- The thread ----

/** Stored messages with IDs by position: the reducer gives new messages random IDs. */
function store(messages: BaseMessage[]): StoredMessage[] {
  return mapChatMessagesToStoredMessages(messages).map((message, index) => ({
    ...message,
    data: {...message.data, id: `m${index}`},
  }));
}

export const langGraphThread = restate.object({
  name: "LangGraphThread",
  handlers: {
    /** Runs one turn of the graph on the thread's conversation. */
    async ask(ctx: restate.ObjectContext, message: string): Promise<string> {
      const history = mapStoredMessagesToChatMessages(
        (await ctx.get<StoredMessage[]>("messages")) ?? [],
      );
      const input = [...history, new HumanMessage({content: message, id: ctx.rand.uuidv4()})];
      const result = await runGraph(ctx, (config) => graph.invoke({messages: input}, config));
      ctx.set("messages", store(result.messages));
      return result.messages.at(-1)!.text;
    },
    /** The question a turn is waiting on, if any. */
    pending: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) =>
      ctx.get<{id: string; question: unknown}>("pending"),
    ),
    /** Answers the waiting question. */
    answer: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext, approved: boolean) => {
        const pending = await ctx.get<{id: string}>("pending");
        if (!pending) throw new restate.TerminalError("No question is waiting for an answer");
        ctx.resolveAwakeable(pending.id, approved);
      },
    ),
  },
});
