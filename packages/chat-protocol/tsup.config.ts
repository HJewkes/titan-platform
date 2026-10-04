import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "agents/index": "src/agents/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
