// A sandbox provider backed by local Docker containers, for running the example without an account.
import {spawn} from "node:child_process";
import type {ExecResult, SandboxProvider} from "@restate-agents/core/sandbox";

function docker(args: string[], options: {input?: string; signal?: AbortSignal} = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn("docker", args, {signal: options.signal});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({exitCode: exitCode ?? 1, stdout, stderr}));
    child.stdin.end(options.input);
  });
}

function check(result: ExecResult): ExecResult {
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "docker failed");
  return result;
}

export function dockerSandboxes({
  image = "node:24-bookworm",
  workdir = "/workspace",
} = {}): SandboxProvider {
  return {
    async create({name}) {
      const run = await docker([
        "run",
        "--detach",
        "--name",
        name,
        "--workdir",
        workdir,
        image,
        "sleep",
        "infinity",
      ]);
      if (run.exitCode === 0) return run.stdout.trim();
      // A retried create finds the container the first attempt started.
      const existing = await docker(["inspect", "--format", "{{.Id}}", name]);
      if (existing.exitCode === 0) return existing.stdout.trim();
      throw new Error(run.stderr.trim());
    },
    async connect(id) {
      const state = await docker(["inspect", "--format", "{{.State.Running}}", id]);
      if (state.stdout.trim() !== "true") throw new Error(`Sandbox ${id} is not running.`);
      return {
        exec: (script, {signal}) => docker(["exec", id, "sh", "-c", script], {signal}),
        async readFile(path) {
          const read = await docker([
            "exec",
            id,
            "sh",
            "-c",
            `[ -f "$1" ] || exit 3; cat "$1"`,
            "sh",
            path,
          ]);
          if (read.exitCode === 3) return undefined;
          return check(read).stdout;
        },
        async writeFile(path, content) {
          const script = `mkdir -p "$(dirname "$1")" && cat > "$1"`;
          check(await docker(["exec", "-i", id, "sh", "-c", script, "sh", path], {input: content}));
        },
      };
    },
    async terminate(id) {
      const removed = await docker(["rm", "--force", id]);
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) check(removed);
    },
  };
}
