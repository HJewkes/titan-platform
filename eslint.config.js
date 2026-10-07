import js from "@eslint/js";
import { recommended as titan } from "@titan-design/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".codewatch/**",
      ".codewatch-tool/**",
      // Holds deliberate violations; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/eslint-recommended/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  titan,
  // A describe or it callback holds a whole suite, so the function limit applies to source only.
  { files: ["**/*.test.{ts,tsx,mts,mjs,js}"], rules: { "titan/max-function-lines": "off" } },
  { languageOptions: { globals: globals.node } },
  { files: ["apps/*/src/**"], languageOptions: { globals: globals.browser } },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
