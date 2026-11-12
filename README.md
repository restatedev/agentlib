# Restate Agents

**TypeScript agents built for durable execution on [Restate](https://restate.dev).**
Run an agent inside a service handler, alongside ordinary application code.
Restate records its progress, so a crash, deploy, or long wait does not mean
starting the work over.

- **Survive the real world.** Model calls, tool results, and approvals are
  journaled; completed work is reused when an invocation resumes.
- **Stay in control while it runs.** Steer or interrupt an agent, check tool
  calls with guardrails, and pause for human approval.
- **Compose agents like services.** Call other handlers through durable RPC,
  delegate to sub-agents, or hand a conversation to a specialist.
- **Bring the tools you need.** Use async functions, Restate services, MCP,
  tool search, background work, and programmatic tool calling.

[Start from the template](https://github.com/restatedev/agentlib-template) ·
[Run the tutorial](#try-it) · [Explore the capabilities](#capabilities) ·
[Browse the numbered examples](packages/examples/README.md)

## The shape of an agent

An agent runs inside your Restate service. Your handler decides when to run it
and what happens before and after. The agent can call a model, use tools, wait
for a person, and continue from the journal when the invocation resumes.

```mermaid
flowchart LR
  Caller[Caller] --> Handler[Restate handler]
  Handler --> Agent[Agent run]
  Agent <--> Model[Model]
  Agent <--> Tools[Tools and services]
  Agent -. progress .-> Journal[(Restate journal)]
  Journal -. replay .-> Agent
```

Install the SDK next to the Restate SDKs it builds on, or clone the
[project template](https://github.com/restatedev/agentlib-template), then start
with one agent and one handler:

```sh
npm install @restatedev/agentlib @restatedev/restate-sdk @restatedev/restate-sdk-gen @ai-sdk/openai
```

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restatedev/agentlib";
import {openai} from "@ai-sdk/openai";
import {aiModel} from "@restatedev/agentlib/provider";

const assistant = agent({model: aiModel({model: openai("gpt-5.6-luna")})});

export const hello = restate.service({
  name: "Hello",
  handlers: {
    *ask(question: string) {
      const result = yield* assistant.run(question);
      // A stopped or interrupted run may still carry a summary in output.
      return result.status === "completed" ? result.output : (result.output ?? result.reason);
    },
  },
});
```

This is lesson 01 without its input schema, on a fixed OpenAI model. Each request starts with no
conversation history. Add a [conversation](packages/examples/src/lessons/03_conversation.ts)
when the agent needs to remember earlier requests, or add
[tools](packages/examples/src/lessons/02_tools.ts) when it needs to act.

## Try it

The [numbered tutorial](packages/examples/README.md) starts with this smallest
agent and builds toward approvals, multi-agent workflows, and a support session
with live controls. Start a Restate server, for example with
`pnpm dlx @restatedev/restate-server`, then run the example endpoint:

```sh
pnpm install --frozen-lockfile
export OPENAI_API_KEY=...
# Each lesson defines its model locally; edit that definition to change providers.
# Lessons that need other keys say so.
pnpm dev
```

In another terminal:

```sh
pnpm dlx @restatedev/restate deployments register http://localhost:9080
curl localhost:8080/Hello/ask --json '{"message":"Say hello in one sentence."}'
```

TypeScript callers can use Restate's typed client instead, as the
[example integration tests](packages/tests/src/examples.integration.ts) do:

```ts
import {connect} from "@restatedev/restate-sdk-clients";
import {hello} from "@restatedev/agentlib-examples/hello";

const answer = await connect({url: "http://localhost:8080"})
  .client(hello)
  .ask({message: "Say hello in one sentence."});
console.log(answer);
```

`pnpm dev` compiles `packages/core` once at startup. After changing it, restart
`pnpm dev` and run the `register` command again so Restate sees changed services.

## What you can build

- **Support that remembers and adapts.** Keep conversation history in a keyed
  object, and steer or interrupt an active run.
  [See the support session](packages/examples/src/lessons/09_support_session.ts).
- **Actions with a human in the loop.** Pause a tool for approval or check a
  budget before it runs.
  [See human approval](packages/examples/src/lessons/06_human_approval.ts) and
  [a tool guardrail](packages/examples/src/lessons/13_tool_guardrail.ts).
- **Agents working together over RPC.** Fan out typed Restate RPCs and
  synthesize the results, or have agents review each other's drafts.
  [See the research report](packages/examples/src/lessons/08_research_report.ts)
  and [the peer review](packages/examples/src/lessons/15_peer_review_rpc.ts).
- **Coding in a Modal sandbox.** Give an agent file and shell tools backed by a
  [Modal](https://modal.com) sandbox (needs Modal credentials).
  [See the coding agent](packages/examples/src/lessons/11_coding_agent.ts).

## Why it keeps working

Restate journals model responses, tool results, and workflow decisions. After a
crash or redeploy, an invocation replays completed steps and continues from the
next one. Your agent does not have to reconstruct its place in a workflow or
repeat a completed model call.

- **Retries are explicit.** Set retry policies on model calls and tools; a terminal
  tool failure becomes a result the agent can handle.
- **Cancellation propagates.** An interrupted run cancels unfinished tools and
  child invocations.
- **Waiting does not occupy a process.** Approvals, sleeps, and slow work
  suspend durably.
- **Composition stays in application code.** Race agents, fan out workers, or
  add an agent to a larger Restate workflow.

## Capabilities

| Capability                   | API                                                                        | Lesson                                                      |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Tools with journaled results | `asyncTool`, `tool`                                                        | [02](packages/examples/src/lessons/02_tools.ts)             |
| Conversation history         | `run(input, {messages})`, `run(input, {conversation})`                     | [03](packages/examples/src/lessons/03_conversation.ts), 09  |
| Typed output                 | `agent({output})`                                                          | [04](packages/examples/src/lessons/04_structured_output.ts) |
| Human approval               | `needsApproval`, `onApproval`, `humanApprovalTool`                         | [06](packages/examples/src/lessons/06_human_approval.ts)    |
| Steering and interruption    | `run(input, {steeringSignal, interruptSignal})` or `{controls}`            | [09](packages/examples/src/lessons/09_support_session.ts)   |
| Progress events              | `run(input, {onProgress})`, `context.progress`                             | [16](packages/examples/src/lessons/16_progress_feed.ts)     |
| Handoffs                     | `handoff`                                                                  | —                                                           |
| Sub-agents as tools          | `agentTool`                                                                | —                                                           |
| Restate services as tools    | `serviceTool`, `handlerTool`, `restateTools` (`/discovery`)                | [10](packages/examples/src/lessons/10_service_tool.ts)      |
| Background tools             | `background: true`, `sleepTool`, `cancelOperationTool`                     | —                                                           |
| Tool search                  | `searchToolsTool`, `deferred: true`                                        | —                                                           |
| Programmatic tool calling    | `programTool` (`/program`), run in a QuickJS sandbox                       | —                                                           |
| MCP                          | `mcpTools` (`/mcp`), passed as `run(input, {tools})`                       | [17](packages/examples/src/lessons/17_mcp_tools.ts)         |
| AG-UI clients                | `onProgress`, `onApproval` and client-run tools as AG-UI events            | [18](packages/examples/src/lessons/18_ag_ui.ts)             |
| Guardrails                   | `beforeRun`, `beforeStep`, `beforeTool`, `afterTool`, `afterRun`, `before` | [13](packages/examples/src/lessons/13_tool_guardrail.ts)    |
| Web search                   | Example-local `asyncTool` calling Tavily                                   | [14](packages/examples/src/lessons/14_web_search.ts)        |
| Skills                       | `agent({skills})` with any `SkillSource`, `skills([...])`                  | [19](packages/examples/src/lessons/19_skills.ts)            |
| Large tool results           | `agent({toolResults})`: previews, read on with `read_tool_result`          | —                                                           |
| Long runs                    | `agent({compaction, contextWindow})`, `ContextOverflowError`               | —                                                           |
| Limits                       | `maxSteps`, `maxToolCalls`, `maxToolDepth`, `maxOutputChars`, `finalize`   | —                                                           |
| Usage totals                 | `result.usage`: input and output tokens, total tokens, and cache counts    | —                                                           |
| Custom model adapters        | `journaledModel`                                                           | —                                                           |
| Models                       | `aiModel`, `modelGateway` (`/provider`)                                    | [01_hello.ts](packages/examples/src/lessons/01_hello.ts)    |

Subpaths are imports from `@restatedev/agentlib`, such as
`@restatedev/agentlib/mcp`. `aiModel` accepts an OpenTelemetry `tracer`, and
marks prompt-cache points for Anthropic and Bedrock unless `caching: false`.

Agents run inside Restate's generator SDK.

## Skills for coding agents

[`plugins/restate-agents`](plugins/restate-agents) teaches coding agents to
build with this SDK. It follows the same learning order as the lessons, with
two skills:

- **`restate-gen-sdk`** covers Restate's generator SDK: services, objects,
  workflows, durable RPC, fan-out, signals, and patterns for composing small
  handlers into larger applications.
- **`restate-agents`** covers the agent lib: tools, conversations,
  approvals, guardrails, live controls, and multi-agent workflows.

The plugin also connects the Restate docs MCP server.

```sh
# Claude Code
/plugin marketplace add restatedev/agentlib
/plugin install restate-agents@restate-agents
# Codex
codex plugin marketplace add restatedev/agentlib
# Cursor, Copilot, Gemini CLI, and others
npx skills add restatedev/agentlib
```

In Cursor, add `https://github.com/restatedev/agentlib` as a marketplace
instead. To try local changes in Claude Code, run
`claude --plugin-dir plugins/restate-agents`.

## Workspace

| Package                                              | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| [`@restatedev/agentlib`](packages/core)              | The agent lib, published to npm, plus the optional subpaths above    |
| [`@restatedev/agentlib-examples`](packages/examples) | Numbered tutorials, from a first run to multi-agent workflows        |
| [`@restatedev/agentlib-tests`](packages/tests)       | Unit, replay, and type tests, plus integration tests against Restate |

The [domain glossary](CONTEXT.md) defines runs, steps, sessions, conversations,
and lifecycle controls.

## Development

Requires Node.js 24+ and pnpm 12. Integration tests also need Docker.

```sh
pnpm build             # compile, TypeScript 7 type check, type-aware Oxlint, Oxfmt check
pnpm test              # unit and journal-replay tests
pnpm test:integration  # a real Restate server with forced replay, via Testcontainers
```

`pnpm check` runs all three. `pnpm lint:fix` and `pnpm format:fix` apply fixes.
[CI](.github/workflows/ci.yml) runs the same checks on every pull request and
push to `main`. Provider and MCP fixtures need no paid credentials.

## Release

To cut a release of `@restatedev/agentlib`, bump the version, commit, and tag
with one command, then push both:

```sh
./scripts/prepare-release.sh 0.1.0        # or 0.2.0-rc.1 for a pre-release
git push --atomic origin HEAD:main v0.1.0
```

The [release workflow](.github/workflows/release.yml) runs CI on the tagged
commit, publishes the package to npm, and creates the GitHub release.
Pre-releases are published under their identifier as dist-tag (`rc`, `beta`),
never as `latest`.
