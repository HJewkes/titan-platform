import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  // `sqlite` exists only as `node:sqlite`; stripping the prefix turns it into a missing npm package.
  removeNodeProtocol: false,
});
