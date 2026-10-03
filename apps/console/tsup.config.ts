import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "server/cli.ts" },
  format: ["esm"],
  // vite build writes dist/index.html first; cleaning here would delete it.
  clean: false,
  sourcemap: true,
});
