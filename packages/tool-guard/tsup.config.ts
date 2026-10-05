import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "shell/index": "src/shell/index.ts", bin: "src/bin.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", "shell/index": "src/shell/index.ts" } },
  clean: true,
  sourcemap: true,
});
