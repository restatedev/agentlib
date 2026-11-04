import assert from "node:assert/strict";
import {after, before, mock, test} from "node:test";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {connect} from "@restatedev/restate-sdk-clients";
import type {Model} from "@restatedev/agentlib";

const model: Model = function* (request) {
  const last = request.messages.at(-1)!;
  if (last.role === "tool") {
    assert.equal(last.result.status, "success");
    if (last.result.status !== "success") throw new Error("Search failed");
    const results = last.result.output as {title: string; url: string; content: string}[];
    assert.equal(results.length, 5);
    assert.equal(results[0]!.content.length, 4000);
    return {type: "final", text: results[0]!.url};
  }
  return {
    type: "tool_calls",
    calls: [{id: "search-1", name: "searchWeb", input: {query: "Restate docs"}}],
  };
};
mock.module("@restatedev/agentlib/openai", {namedExports: {openAIModel: () => model}});
const {webResearch} = await import("@restatedev/agentlib-examples/web-search");
let env: RestateTestEnvironment;
before(
  async () => {
    env = await RestateTestEnvironment.start({
      services: [webResearch],
      container: () => new RestateContainer().alwaysReplay().disableRetries(),
    });
  },
  {timeout: 60000},
);
after(async () => {
  await env?.stop();
});

void test("the local Tavily tool bounds results and does not repeat HTTP on replay", async () => {
  const originalKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "test-tavily-key";
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const mocked = mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    if (args[0] !== "https://api.tavily.com/search") return originalFetch(...args);
    requests++;
    const init = args[1]!;
    assert.equal(init.method, "POST");
    assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-tavily-key");
    assert.deepEqual(JSON.parse(init.body as string), {
      query: "Restate docs",
      max_results: 5,
      include_raw_content: false,
    });
    return Response.json({
      results: Array.from({length: 8}, (_, index) => ({
        title: "Restate",
        url: "https://docs.restate.dev/",
        content: index === 0 ? "x".repeat(5000) : "Short snippet.",
      })),
    });
  });
  try {
    assert.equal(
      await connect({url: env.baseUrl()}).client(webResearch).answer("Find Restate docs"),
      "https://docs.restate.dev/",
    );
    assert.equal(requests, 1);
  } finally {
    mocked.mock.restore();
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  }
});
