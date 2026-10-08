// Skills: instructions for a kind of task, loaded when a task needs them.
// The model first sees each skill's name and description, after the agent's
// instructions; it loads a skill with `load_skill` and the files the skill
// refers to with `read_skill_file`:
//
//   instructions + "## Skills\n- pdf-forms: Fill in PDF forms. ..."
//   load_skill({name: "pdf-forms"})                        -> the skill's instructions
//   read_skill_file({name: "pdf-forms", path: "fields.md"}) -> one of its files
//
// The source is the application's: files, a repository, state, or code. The
// run lists it once, so the instructions, and with them the cached prefix,
// stay the same all run. Every call is journaled.
import {TerminalError} from "@restatedev/restate-sdk";
import {run, type Operation} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {ToolError} from "./errors.js";
import {asyncTool} from "./tool.js";
import type {SkillSource, SkillSummary, Tool} from "./types.js";

export const LOAD_SKILL = "load_skill";
export const READ_SKILL_FILE = "read_skill_file";
const DEFAULT_RETRY = {maxAttempts: 3};
// Names as in Anthropic's Agent Skills format; the model calls skills by name.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;

/** Lists a source's skills once, journaled, and checks the list. */
export function* listSkills(source: SkillSource): Operation<SkillSummary[]> {
  const listed = yield* run(
    async ({signal}) =>
      (await source.list({signal})).map(({name, description, location}) =>
        location === undefined ? {name, description} : {name, description, location},
      ),
    {name: "skills:list", retry: source.retry ?? DEFAULT_RETRY},
  );
  const names = new Set<string>();
  for (const {name, description} of listed) {
    if (!NAME.test(name) || name.length > MAX_NAME)
      throw new TerminalError(
        `Invalid skill name "${name}": use up to ${MAX_NAME} lowercase letters, digits and hyphens`,
      );
    // The model picks skills by description, so each needs one. Its length is
    // the source's choice: published skills exceed the format's 1024 characters.
    if (!description) throw new TerminalError(`Skill "${name}" needs a description`);
    if (names.has(name)) throw new TerminalError(`Duplicate skill name: ${name}`);
    names.add(name);
  }
  return listed;
}

/** The section the run appends to the agent's instructions. */
export function skillsSection(skills: SkillSummary[], canRead: boolean): string {
  const lines = [
    "## Skills",
    `Skills are instructions for specific kinds of tasks. When a task matches a skill's description, call ${LOAD_SKILL} with its name before you start, and follow what it says.` +
      (canRead ? ` Read a file the skill refers to with ${READ_SKILL_FILE}.` : ""),
    ...skills.map(({name, description}) => `- ${name}: ${description}`),
  ];
  return lines.join("\n");
}

/** The tools that load a run's skills. */
export function skillTools<C>(
  source: SkillSource,
  skills: SkillSummary[],
): Record<string, Tool<C>> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const retry = source.retry ?? DEFAULT_RETRY;
  const known = (name: string) => {
    const skill = byName.get(name);
    if (!skill)
      throw new ToolError(
        `Unknown skill "${name}". Skills: ${[...byName.keys()].join(", ")}`,
        "invalid_input",
      );
    return skill;
  };
  const tools: Record<string, Tool<C>> = {
    [LOAD_SKILL]: asyncTool({
      description: "Load a skill's instructions by its name.",
      input: z.object({name: z.string().describe("The skill's name, as listed.")}),
      retry,
      async execute({name}, {signal}) {
        return await source.load(known(name), {signal});
      },
    }),
  };
  const read = source.read?.bind(source);
  if (read)
    tools[READ_SKILL_FILE] = asyncTool({
      description: "Read a file that a loaded skill refers to.",
      input: z.object({
        name: z.string().describe("The skill's name."),
        path: z.string().describe("The file's path relative to the skill, as the skill gives it."),
      }),
      retry,
      async execute({name, path}, {signal}) {
        const skill = known(name);
        // A source reads from its own store; a path never leaves the skill.
        if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
          throw new ToolError(
            "A skill file path is relative and stays in the skill",
            "invalid_input",
          );
        return await read(skill, path, {signal});
      },
    });
  return tools;
}

/** A skill written in code: its instructions and the files they refer to. */
export type SkillDefinition = SkillSummary & {
  instructions: string;
  files?: Record<string, string>;
};

/** A source for skills defined in code. */
export function skills(definitions: SkillDefinition[]): SkillSource {
  const byName = new Map(definitions.map((skill) => [skill.name, skill]));
  const find = (name: string) => {
    const skill = byName.get(name);
    if (!skill) throw new ToolError(`Unknown skill "${name}"`, "invalid_input");
    return skill;
  };
  return {
    async list() {
      return definitions.map(({name, description}) => ({name, description}));
    },
    async load({name}) {
      return find(name).instructions;
    },
    async read({name}, path) {
      const file = find(name).files?.[path];
      if (file === undefined)
        throw new ToolError(`Skill "${name}" has no file "${path}"`, "invalid_input");
      return file;
    },
  };
}
