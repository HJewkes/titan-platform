import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "shell/index": "src/shell/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
