import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", limits: "src/limits/index.ts", "limits-node": "src/limits/node.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
