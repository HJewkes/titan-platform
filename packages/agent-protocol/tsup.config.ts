import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "harness/index": "src/harness/index.ts", index: "src/index.ts", "trace/index": "src/trace/index.ts", "worker-facts": "src/worker-facts.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
