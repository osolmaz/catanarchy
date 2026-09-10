import { watchFile, unwatchFile } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunManifest, RunPackage } from "@catanarchy/run-log";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const fromRoot = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sendJson = (response: import("node:http").ServerResponse, value: unknown): void => {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
};

const sendText = (
  response: import("node:http").ServerResponse,
  status: number,
  text: string,
): void => {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
};

const sendError = (response: import("node:http").ServerResponse, error: unknown): void => {
  sendText(response, 500, error instanceof Error ? error.message : "Could not read the run.");
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const decodeSeatId = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

type ReadRunPackage = (directory: string) => Promise<RunPackage>;

const sessionPathForSeat = (root: string, manifest: RunManifest, seatId: string): string | null => {
  const sessionFile = manifest.seats.find(({ seatId: id }) => id === seatId)?.sessionFile;
  if (sessionFile === null || sessionFile === undefined) return null;
  const path = resolve(root, sessionFile);
  const localPath = relative(root, path);
  if (localPath.startsWith("..") || isAbsolute(localPath)) {
    throw new Error("The Pi session path is outside the run directory.");
  }
  return path;
};

export const resolveContainedRealPath = async (
  root: string,
  path: string,
): Promise<string | null> => {
  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  const localPath = relative(realRoot, realPath);
  if (localPath.startsWith("..") || isAbsolute(localPath)) {
    throw new Error("The Pi session path resolves outside the run directory.");
  }
  return realPath;
};

const readPiSession = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
};

const servePiSession = async (
  readRunPackage: ReadRunPackage,
  root: string,
  encodedSeatId: string,
  response: import("node:http").ServerResponse,
): Promise<void> => {
  const seatId = decodeSeatId(encodedSeatId);
  if (seatId === null) {
    sendText(response, 400, "The seat ID is invalid.");
    return;
  }
  const { manifest } = await readRunPackage(root);
  const path = sessionPathForSeat(root, manifest, seatId);
  if (path === null) {
    sendText(response, 404, "No Pi session exists for this seat.");
    return;
  }
  const realPath = await resolveContainedRealPath(root, path);
  const content = realPath === null ? null : await readPiSession(realPath);
  if (content === null) {
    sendText(response, 404, "The Pi session file is not available yet.");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Content-Disposition", 'attachment; filename="pi-session.jsonl"');
  response.setHeader("Cache-Control", "no-store");
  response.end(content);
};

const reportPlugin = (report: string | undefined): Plugin => ({
  name: "catanarchy-local-run-report",
  configureServer(server) {
    if (report === undefined) return;
    server.middlewares.use("/__catanarchy/run-report", (_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(report);
    });
  },
});

const runPackagePlugin = (directory: string | undefined): Plugin => ({
  name: "catanarchy-local-run-package",
  configureServer(server) {
    if (directory === undefined) return;
    const readRunPackage: ReadRunPackage = async (runDirectory) => {
      const module = (await server.ssrLoadModule(fromRoot("packages/run-log/src/index.ts"))) as {
        readonly readRunPackage: ReadRunPackage;
      };
      return module.readRunPackage(runDirectory);
    };
    const root = resolve(directory);
    const timelinePath = resolve(root, "timeline.jsonl");
    const manifestPath = resolve(root, "manifest.json");

    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://catanarchy.local");
      if (url.pathname === "/__catanarchy/run-snapshot") {
        void readRunPackage(root).then(
          (run) => sendJson(response, run),
          (error: unknown) => sendError(response, error),
        );
        return;
      }
      if (url.pathname.startsWith("/__catanarchy/session/")) {
        const encodedSeatId = url.pathname.slice("/__catanarchy/session/".length);
        void servePiSession(readRunPackage, root, encodedSeatId, response).catch((error: unknown) =>
          sendError(response, error),
        );
        return;
      }
      if (url.pathname !== "/__catanarchy/run-stream") {
        next();
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();
      const requestedAfter = Number(
        request.headers["last-event-id"] ?? url.searchParams.get("after") ?? -1,
      );
      let cursor = Number.isSafeInteger(requestedAfter) ? requestedAfter : -1;
      let lastManifest = "";
      let sending = false;
      let sendAgain = false;

      const send = async (): Promise<void> => {
        if (sending) {
          sendAgain = true;
          return;
        }
        sending = true;
        try {
          const run = await readRunPackage(root);
          const manifest = JSON.stringify(run.manifest);
          if (manifest !== lastManifest) {
            response.write(`event: manifest\ndata: ${manifest}\n\n`);
            lastManifest = manifest;
          }
          for (const record of run.records) {
            if (record.index <= cursor) continue;
            response.write(
              `id: ${record.index}\ndata: ${JSON.stringify({ manifest: run.manifest, record, verification: run.verification })}\n\n`,
            );
            cursor = record.index;
          }
        } catch (error) {
          response.write(
            `event: run-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "Could not read the run." })}\n\n`,
          );
        } finally {
          sending = false;
          if (sendAgain) {
            sendAgain = false;
            void send();
          }
        }
      };
      const changed = (): void => void send();
      watchFile(timelinePath, { interval: 200 }, changed);
      watchFile(manifestPath, { interval: 200 }, changed);
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unwatchFile(timelinePath, changed);
        unwatchFile(manifestPath, changed);
      });
      void send();
    });
  },
});

export default defineConfig(async () => {
  const runFile = process.env["CATANARCHY_RUN_FILE"];
  const runDirectory = process.env["CATANARCHY_RUN_DIR"];
  if (runFile !== undefined && runDirectory !== undefined) {
    throw new Error("Set only one of CATANARCHY_RUN_FILE and CATANARCHY_RUN_DIR.");
  }
  const report = runFile === undefined ? undefined : await readFile(runFile, "utf8");
  if (report !== undefined) JSON.parse(report);
  const source = report === undefined ? (runDirectory === undefined ? null : "package") : "report";
  return {
    root: import.meta.dirname,
    plugins: [react(), reportPlugin(report), runPackagePlugin(runDirectory)],
    define: {
      __CATANARCHY_RUN_SOURCE__: JSON.stringify(source),
    },
    resolve: {
      alias: {
        "@catanarchy/engine": fromRoot("packages/engine/src/index.ts"),
        "@catanarchy/protocol": fromRoot("packages/protocol/src/index.ts"),
        "@catanarchy/run-log": fromRoot("packages/run-log/src/index.ts"),
      },
    },
    build: {
      outDir: "../../dist/web",
      emptyOutDir: true,
    },
  };
});
