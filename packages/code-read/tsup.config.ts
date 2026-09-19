import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/query/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
