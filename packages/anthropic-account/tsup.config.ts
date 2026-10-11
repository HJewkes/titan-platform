import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", node: "src/node/index.ts", bin: "src/cli/bin.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", node: "src/node/index.ts" } },
  clean: true,
  sourcemap: true,
});
