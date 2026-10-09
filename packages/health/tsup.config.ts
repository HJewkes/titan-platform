import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "metrics/index": "src/metrics/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
