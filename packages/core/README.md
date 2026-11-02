# @restatedev/agentlib

**TypeScript agents built for durable execution on [Restate](https://restate.dev).**
Run an agent inside a Restate service handler, alongside ordinary application
code. Model calls, tool results, and approvals are journaled, so a crash,
deploy, or long wait does not mean starting the work over.

```sh
npm install @restatedev/agentlib @restatedev/restate-sdk @restatedev/restate-sdk-gen
```

Or start from the [project template](https://github.com/restatedev/agentlib-template),
a ready-to-run Restate service with one agent.

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restatedev/agentlib";
import {openAIModel} from "@restatedev/agentlib/openai";

const assistant = agent({model: openAIModel({model: "gpt-5.6-luna"})});

export const hello = restate.service({
  name: "Hello",
  handlers: {
    *ask(question: string) {
      const result = yield* assistant.run(question);
      return result.status === "completed" ? result.output : (result.output ?? result.reason);
    },
  },
});
```

The [repository README](https://github.com/restatedev/agentlib#readme) walks
through the capabilities, and the
[numbered examples](https://github.com/restatedev/agentlib/tree/main/packages/examples)
go from a first run to multi-agent workflows.

## Subpaths

| Import                            | Purpose                                       |
| --------------------------------- | --------------------------------------------- |
| `@restatedev/agentlib`            | Agents, tools, conversations, guardrails      |
| `@restatedev/agentlib/openai`     | OpenAI and Chat Completions-compatible models |
| `@restatedev/agentlib/provider`   | Models through the Vercel AI SDK providers    |
| `@restatedev/agentlib/mcp`        | Tools from MCP servers                        |
| `@restatedev/agentlib/program`    | Programmatic tool calling in a sandbox        |
| `@restatedev/agentlib/web-search` | Web search tools                              |
| `@restatedev/agentlib/discovery`  | Expose agents and tools for discovery         |

## License

MIT
