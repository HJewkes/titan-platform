// Type-aware lint, run by `pnpm lint:types` as its own CI job. It needs every package built, because
// packages resolve each other's types through dist, and it is uncached: a file's verdict depends on other files.
import tseslint from "typescript-eslint";

const TYPED_FILES = [
  "packages/*/src/**/*.{ts,mts,cts,tsx}",
  "products/*/src/**/*.{ts,mts,cts,tsx}",
  "apps/codewatch/{src,server,scripts}/**/*.{ts,tsx}",
  "apps/console/{src,server}/**/*.{ts,tsx}",
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  {
    files: TYPED_FILES,
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    // Only these three rules run here, so disable comments for the syntax rules in eslint.config.js would read as unused.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
);
