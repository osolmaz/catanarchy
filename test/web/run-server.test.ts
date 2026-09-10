import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContainedRealPath } from "../../apps/web/vite.config.js";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "catanarchy-run-server-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local run server", () => {
  it("resolves a session file inside the real run directory", async () => {
    const root = await temporaryRoot();
    const sessions = resolve(root, "sessions");
    const path = resolve(sessions, "red.jsonl");
    await mkdir(sessions);
    await writeFile(path, "{}\n");

    await expect(resolveContainedRealPath(root, path)).resolves.toBe(await realpath(path));
    await expect(resolveContainedRealPath(root, resolve(sessions, "missing.jsonl"))).resolves.toBe(
      null,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a session symlink that leaves the run directory",
    async () => {
      const root = await temporaryRoot();
      const sessions = resolve(root, "sessions");
      const outside = resolve(root, "..", `${root.split("/").at(-1)}-outside.jsonl`);
      await mkdir(sessions);
      await writeFile(outside, "private\n");
      roots.push(outside);
      const link = resolve(sessions, "red.jsonl");
      await symlink(outside, link);

      await expect(resolveContainedRealPath(root, link)).rejects.toThrow(
        "resolves outside the run directory",
      );
    },
  );
});
