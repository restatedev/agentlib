// A sandbox provider backed by Modal Sandboxes. Reads credentials from MODAL_TOKEN_ID/SECRET or ~/.modal.toml.
import {
  AlreadyExistsError,
  ModalClient,
  NotFoundError,
  SandboxFilesystemNotFoundError,
} from "modal";
import {lazySandbox, type SandboxProvider} from "@restate-agents/core/sandbox";

const abortable = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    promise.then(resolve, reject);
  });

export function modalSandboxes({
  app = "restate-agents",
  image = "node:24-bookworm",
  workdir = "/workspace",
  // Modal ends a sandbox after five minutes unless told otherwise.
  timeoutMs = 24 * 60 * 60 * 1000,
  idleTimeoutMs = 60 * 60 * 1000,
} = {}): SandboxProvider {
  // Connect on first use, so importing this module needs no credentials.
  let client: ModalClient | undefined;
  const modal = () => (client ??= new ModalClient());
  return {
    async create({name}) {
      const owner = await modal().apps.fromName(app, {createIfMissing: true});
      try {
        const sandbox = await modal().sandboxes.create(owner, modal().images.fromRegistry(image), {
          name,
          workdir,
          timeoutMs,
          idleTimeoutMs,
        });
        return sandbox.sandboxId;
      } catch (error) {
        // A retried create finds the sandbox the first attempt started.
        if (!(error instanceof AlreadyExistsError)) throw error;
        return (await modal().sandboxes.fromName(app, name)).sandboxId;
      }
    },
    connect: (id) =>
      lazySandbox(async () => {
        const sandbox = await modal().sandboxes.fromId(id);
        return {
          async exec(script, {signal}) {
            const process = await sandbox.exec(["sh", "-c", script], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await abortable(
              Promise.all([process.stdout.readText(), process.stderr.readText(), process.wait()]),
              signal,
            );
            return {exitCode, stdout, stderr};
          },
          async readFile(path) {
            try {
              return await sandbox.filesystem.readText(path);
            } catch (error) {
              if (error instanceof SandboxFilesystemNotFoundError) return undefined;
              throw error;
            }
          },
          writeFile: (path, content) => sandbox.filesystem.writeText(content, path),
        };
      }),
    async terminate(id) {
      try {
        await (await modal().sandboxes.fromId(id)).terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
  };
}
