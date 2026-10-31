import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "server/cli.ts", "round-frame-delta-worker": "server/round-frame-delta-worker.ts" },
  format: ["esm"],
  // vite build writes dist/index.html first; cleaning here would delete it.
  clean: false,
  sourcemap: true,
});
