import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "limits/index": "src/limits/index.ts",
    "limits/node": "src/limits/node.ts",
    "routing/index": "src/routing/index.ts",
    "routing/node": "src/routing/node.ts",
    "profiles/index": "src/profiles/index.ts",
    "profiles/node": "src/profiles/node.ts",
    "launch/index": "src/launch/index.ts",
    "brief/index": "src/brief/index.ts",
    "host/index": "src/host/index.ts",
    "roster/index": "src/roster/index.ts",
    "gates/index": "src/gates/index.ts",
    "isolation/index": "src/isolation/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
