import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node-kinds.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
