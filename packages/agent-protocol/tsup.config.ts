import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "trace/index": "src/trace/index.ts", "worker-facts": "src/worker-facts.ts", "wire/index": "src/wire/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
