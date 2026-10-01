import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "stats/index": "src/stats/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
