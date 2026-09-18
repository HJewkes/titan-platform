---
"@titan-design/style-checker": minor
---

Add `@titan-design/style-checker`, ported unchanged from codewatch's checker: `generateRuffConfig` and `generateEslintConfig` from a style profile, `orchestrate` to run ruff and ESLint over files, `parseEslintJsonOutput`, `parseRuffJsonOutput` and `formatDiagnostic` to normalize their output, and `diffAgainstProfile` (moved down from codewatch's CLI) to compare style-analyzer observations with a profile.
