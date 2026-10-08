import assert from "node:assert/strict";
import {test} from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import * as r from "@restatedev/restate-sdk-gen";
import {
  agent,
  skills,
  type Message,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type SkillSource,
} from "@restate-agents/core";
import {runHandler} from "./replay-harness.mjs";

const forms = {
  name: "pdf-forms",
  description: "Fill in PDF forms.",
  instructions: "List the fields first. See fields.md for the field types.",
  files: {"fields.md": "Text, checkbox, signature."},
};

/** A source that counts its calls, to tell a journaled replay from a new call. */
function counted(source: SkillSource) {
  const calls: string[] = [];
  const wrapped: SkillSource = {
    async list(options) {
      calls.push("list");
      return source.list(options);
    },
    async load(skill, options) {
      calls.push(`load ${skill.name}`);
      return source.load(skill, options);
    },
    async read(skill, path, options) {
      calls.push(`read ${skill.name}/${path}`);
      return source.read!(skill, path, options);
    },
  };
  return {calls, source: wrapped};
}

function toolOutputs(messages: Message[]) {
  return messages.flatMap((message) => (message.role === "tool" ? [message.result] : []));
}

function scripted(responses: ModelResponse[]): {requests: ModelRequest[]; model: Model} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: function* (request: ModelRequest): Generator<never, ModelResponse> {
      requests.push(structuredClone(request));
      // By step, so a replay that runs the model again gets the same answers.
      return responses[(request.step ?? 1) - 1] ?? {type: "final", text: "done"};
    },
  };
}

void test("the model loads a skill and its file; replay calls the source again for nothing", async () => {
  const {calls, source} = counted(skills([forms]));
  const {requests, model} = scripted([
    {type: "tool_calls", calls: [{id: "1", name: "load_skill", input: {name: "pdf-forms"}}]},
    {
      type: "tool_calls",
      calls: [{id: "2", name: "read_skill_file", input: {name: "pdf-forms", path: "fields.md"}}],
    },
  ]);
  const filler = agent({instructions: "Help with documents.", model, skills: source});
  const handler = (ctx: Context) => r.execute(ctx, filler.run("Fill in this form."));

  const live = await runHandler(handler);
  assert.equal(live.output.status, "completed");
  assert.deepEqual(toolOutputs(live.output.messages), [
    {status: "success", output: forms.instructions},
    {status: "success", output: forms.files["fields.md"]},
  ]);
  assert.deepEqual(calls, ["list", "load pdf-forms", "read pdf-forms/fields.md"]);

  // The skills follow the instructions, the same in every request, so the
  // cached prefix holds all run.
  const [first] = requests;
  assert.match(first!.instructions!, /^Help with documents\.\n\n## Skills\n/);
  assert.match(first!.instructions!, /- pdf-forms: Fill in PDF forms\./);
  for (const request of requests) {
    assert.equal(request.instructions, first!.instructions);
    assert.deepEqual(request.tools, first!.tools);
  }
  assert.deepEqual(
    first!.tools.map((tool) => tool.name),
    ["load_skill", "read_skill_file", "read_tool_result"],
  );

  const replay = await runHandler(handler, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(calls.length, 3);
});

void test("an unknown skill or a path out of the skill is a tool error", async () => {
  const {calls, source} = counted(skills([forms]));
  const {model} = scripted([
    {
      type: "tool_calls",
      calls: [
        {id: "1", name: "load_skill", input: {name: "tax-returns"}},
        {id: "2", name: "read_skill_file", input: {name: "pdf-forms", path: "../secrets.md"}},
        {id: "3", name: "read_skill_file", input: {name: "pdf-forms", path: "missing.md"}},
      ],
    },
  ]);
  const filler = agent({model, skills: source});
  const live = await runHandler((ctx: Context) => r.execute(ctx, filler.run("Go")));
  const codes = toolOutputs(live.output.messages).map((result) =>
    result.status === "error" ? result.code : result.status,
  );
  assert.deepEqual(codes, ["invalid_input", "invalid_input", "invalid_input"]);
  // Only the missing file reached the source.
  assert.deepEqual(calls, ["list", "read pdf-forms/missing.md"]);
});

void test("a source without files offers no reader, and an empty one adds nothing", async () => {
  const instructionsOnly: SkillSource = {
    list: async () => [{name: "tone", description: "Answer in a friendly tone."}],
    load: async () => "Be friendly.",
  };
  const first = scripted([]);
  await runHandler((ctx: Context) =>
    r.execute(ctx, agent({model: first.model, skills: instructionsOnly}).run("Hi")),
  );
  assert.deepEqual(
    first.requests[0]!.tools.map((tool) => tool.name),
    ["load_skill", "read_tool_result"],
  );
  assert.doesNotMatch(first.requests[0]!.instructions!, /read_skill_file/);

  const empty = scripted([]);
  await runHandler((ctx: Context) =>
    r.execute(
      ctx,
      agent({instructions: "Help.", model: empty.model, skills: skills([])}).run("Hi"),
    ),
  );
  assert.equal(empty.requests[0]!.instructions, "Help.");
  assert.deepEqual(empty.requests[0]!.tools, []);
});

void test("a skill with an invalid name fails the run", async () => {
  const bad = skills([{name: "PDF Forms", description: "Fill in PDF forms.", instructions: "-"}]);
  const {model} = scripted([]);
  const live = await runHandler(async (ctx: Context) => {
    try {
      return await r.execute(ctx, agent({model, skills: bad}).run("Go"));
    } catch (error) {
      return {failed: (error as Error).message};
    }
  });
  assert.match(live.output.failed, /Invalid skill name "PDF Forms"/);
});

void test("a skill tool name cannot be taken by a run tool", async () => {
  const {model} = scripted([]);
  const live = await runHandler(async (ctx: Context) => {
    try {
      return await r.execute(
        ctx,
        agent({model, skills: skills([forms])}).run("Go", {
          tools: {
            load_skill: {
              description: "Mine",
              inputSchema: {type: "object"},
              *execute() {
                return null;
              },
            },
          },
        }),
      );
    } catch (error) {
      return {failed: (error as Error).message};
    }
  });
  assert.match(live.output.failed, /Duplicate tool name: load_skill/);
});

void test("load and read get the skill's listed location", async () => {
  const seen: (string | undefined)[] = [];
  const pinned: SkillSource = {
    list: async () => [{name: "tone", description: "Answer kindly.", location: "commit-abc/tone"}],
    async load(skill) {
      seen.push(skill.location);
      return "Be kind.";
    },
    async read(skill) {
      seen.push(skill.location);
      return "Examples.";
    },
  };
  const {requests, model} = scripted([
    {
      type: "tool_calls",
      calls: [
        {id: "1", name: "load_skill", input: {name: "tone"}},
        {id: "2", name: "read_skill_file", input: {name: "tone", path: "examples.md"}},
      ],
    },
  ]);
  await runHandler((ctx: Context) => r.execute(ctx, agent({model, skills: pinned}).run("Hi")));
  assert.deepEqual(seen, ["commit-abc/tone", "commit-abc/tone"]);
  // The model sees names and descriptions, never locations.
  assert.doesNotMatch(requests[0]!.instructions!, /commit-abc/);
});
