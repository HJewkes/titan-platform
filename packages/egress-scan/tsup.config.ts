import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts", "hooks/index": "src/hooks/index.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", "hooks/index": "src/hooks/index.ts" } },
  clean: true,
  sourcemap: true,
});
