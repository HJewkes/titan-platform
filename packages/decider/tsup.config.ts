import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ask-lint-bin.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
});
