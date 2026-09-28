import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "trace/index": "src/trace/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
