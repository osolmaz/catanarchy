import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const fromRoot = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const runReportPlugin = (report: string | undefined): Plugin => ({
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

export default defineConfig(async () => {
  const runFile = process.env["CATANARCHY_RUN_FILE"];
  const report = runFile === undefined ? undefined : await readFile(runFile, "utf8");
  if (report !== undefined) JSON.parse(report);
  return {
    root: import.meta.dirname,
    plugins: [react(), runReportPlugin(report)],
    define: {
      __CATANARCHY_RUN_REPORT__: JSON.stringify(report !== undefined),
    },
    resolve: {
      alias: {
        "@catanarchy/engine": fromRoot("packages/engine/src/index.ts"),
        "@catanarchy/protocol": fromRoot("packages/protocol/src/index.ts"),
      },
    },
    build: {
      outDir: "../../dist/web",
      emptyOutDir: true,
    },
  };
});
