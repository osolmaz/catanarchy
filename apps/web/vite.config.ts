import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromRoot = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
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
});
