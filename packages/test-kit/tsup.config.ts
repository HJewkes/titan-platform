import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/git.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
