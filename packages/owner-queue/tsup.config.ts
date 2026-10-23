import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/spool.ts", "src/withdraw.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
