import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "pricing/index": "src/pricing/index.ts", "harness/index": "src/harness/index.ts", index: "src/index.ts", "trace/index": "src/trace/index.ts", "worker-facts": "src/worker-facts.ts", "lifecycle-schema": "src/lifecycle-schema.ts", "source-schema": "src/source-schema.ts","wire/index": "src/wire/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
