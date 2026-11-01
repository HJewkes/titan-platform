import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/bin.ts"],
    format: ["esm"],
    dts: { entry: "src/index.ts" },
    // Both builds write under dist/ at once, so neither may clear it.
    clean: false,
    sourcemap: true,
  },
  {
    // Claude Code loads plugin/ as it is, so the mod is one self-contained module, copied beside hooks.json.
    entry: { register: "src/mod/register.tsx" },
    outDir: "dist/mod",
    onSuccess: "cp dist/mod/register.js plugin/hooks/register.js",
    format: ["esm"],
    platform: "neutral",
    outExtension: () => ({ js: ".js" }),
    external: ["claude-code"],
    noExternal: ["@titan-design/rpc-protocol"],
    clean: false,
    dts: false,
    esbuildOptions(options) {
      options.jsxFactory = "h";
      options.jsxFragment = "Fragment";
    },
  },
]);
