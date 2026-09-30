import assert from "node:assert/strict";
import {after, before, mock, test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {connect} from "@restatedev/restate-sdk-clients";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {BaseChatModel} from "@langchain/core/language_models/chat_models";
import {AIMessage, type BaseMessage} from "@langchain/core/messages";
import type {ChatResult} from "@langchain/core/outputs";

/** Every call that reached the model; a journaled call must not repeat on replay. */
const calls: string[] = [];

/** A scripted stand-in for ChatOpenAI that reads the conversation to answer. */
class ScriptedModel extends BaseChatModel {
  _llmType() {
    return "scripted";
  }
  override bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const humans = messages.filter((message) => message.type === "human");
    const question = humans.at(-1)!.text;
    const turn = humans.length;
    const results = messages
      .slice(messages.lastIndexOf(humans.at(-1)!))
      .filter((m) => m.type === "tool");
    calls.push(`${question} #${results.length}`);
    const reply = (fields: ConstructorParameters<typeof AIMessage>[0]) => ({
      generations: [{message: new AIMessage(fields), text: ""}],
    });
    if (question.startsWith("Where are")) {
      if (results.length === 0)
        return reply({
          content: "",
          // Two calls in one message: ToolNode runs them in parallel.
          tool_calls: ["O-7", "O-8"].map((orderId) => ({
            id: `lookup-${orderId}-${turn}`,
            name: "lookupOrder",
            args: {orderId},
          })),
        });
      assert.deepEqual(
        results.map((m) => JSON.parse(m.text).orderId),
        ["O-7", "O-8"],
      );
      return reply({content: "O-7 and O-8 are delivered."});
    }
    if (question.startsWith("Refund")) {
      if (results.length === 0)
        return reply({
          content: "",
          tool_calls: [{id: `refund-${turn}`, name: "refundOrder", args: {orderId: "O-7"}}],
        });
      const [result] = results;
      return reply({
        content: result!.text.includes("denied") ? "The refund was denied." : "O-7 was refunded.",
      });
    }
    return reply({content: `Earlier questions: ${turn - 1}`});
  }
}

mock.module("@langchain/openai", {namedExports: {ChatOpenAI: ScriptedModel}});
const {langGraphThread} = await import("@restate-agents/examples/langgraph");

let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [langGraphThread],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});

const thread = (key: string) => connect({url: env.baseUrl()}).objectClient(langGraphThread, key);

async function pending(key: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const question = await thread(key).pending();
    if (question) return question;
    await delay(50);
  }
  throw new Error("The turn never asked for approval");
}

void test("parallel tool calls run through ToolNode, and each model call runs once", async () => {
  calls.length = 0;
  assert.equal(await thread("lookups").ask("Where are O-7 and O-8?"), "O-7 and O-8 are delivered.");
  // Always-replay re-runs the handler after every journaled step; only two calls are real.
  assert.deepEqual(calls, ["Where are O-7 and O-8? #0", "Where are O-7 and O-8? #2"]);
});

void test("the thread keeps its conversation between turns", async () => {
  await thread("memory").ask("Hello");
  assert.equal(await thread("memory").ask("Hello again"), "Earlier questions: 1");
});

for (const approved of [true, false]) {
  void test(`a refund waits for a person, who ${approved ? "approves" : "denies"} it`, async () => {
    const key = `refund-${approved}`;
    calls.length = 0;
    const answer = thread(key).ask("Refund O-7");
    assert.deepEqual((await pending(key)).question, {refunds: [{orderId: "O-7"}]});
    await thread(key).answer(approved);
    assert.equal(await answer, approved ? "O-7 was refunded." : "The refund was denied.");
    // The resumed turn continues in the review node: the first model call is not repeated.
    assert.deepEqual(calls, ["Refund O-7 #0", "Refund O-7 #1"]);
    assert.equal(await thread(key).pending(), null);
  });
}
