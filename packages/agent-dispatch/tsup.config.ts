import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "limits/index": "src/limits/index.ts",
    "limits/node": "src/limits/node.ts",
    "routing/index": "src/routing/index.ts",
    "routing/node": "src/routing/node.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
