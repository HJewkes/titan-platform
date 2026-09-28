---
"@titan-design/style-checker": minor
---

The ESLint generator now calls `buildNamingConvention` instead of the deprecated `buildNamingConventionRule`, so a naming value typescript-eslint has no format for (e.g. `kebab-case`) is reported in the checker's `skippedRules` output with a reason, instead of being silently dropped. `generateEslintConfig` now returns `{ entries, skippedRules }` instead of a bare array.
