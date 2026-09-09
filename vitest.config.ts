import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@catanarchy/engine": fromRoot("packages/engine/src/index.ts"),
      "@catanarchy/harness": fromRoot("packages/harness/src/index.ts"),
      "@catanarchy/pi-agent": fromRoot("packages/pi-agent/src/index.ts"),
      "@catanarchy/protocol": fromRoot("packages/protocol/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "packages/engine/src/**/*.ts",
        "packages/harness/src/**/*.ts",
        "packages/pi-agent/src/**/*.ts",
        "packages/protocol/src/**/*.ts",
      ],
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
