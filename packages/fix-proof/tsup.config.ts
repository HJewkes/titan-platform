import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts", judge: "src/judge-entry.ts", "linear-regexp": "src/linear-regexp.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", "linear-regexp": "src/linear-regexp.ts" } },
  clean: true,
  sourcemap: true,
});
