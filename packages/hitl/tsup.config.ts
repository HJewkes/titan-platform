import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/sqlite.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
