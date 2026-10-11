import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts", "src/titan-gh.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
});
