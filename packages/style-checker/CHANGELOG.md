# @titan-design/style-checker

## 0.2.0

### Minor Changes

- 1963d4e: Add `AUDIT_RUFF_RULES`, `generateRuffAuditConfig` and `runRuffAudit`, a pinned ruff rule set run with preview on and repo-relative paths. `CheckDiagnostic` gains `endLine`, filled from ruff's `end_location`.

## 0.1.0

### Minor Changes

- 5483ba3: Tool failures now surface, and the ESLint run loads its plugins. Before this, ESLint 9 rejected every generated config (plugin rules with no plugins, no TypeScript parser, and an invalid `info` severity), and the runners read only stdout, so every ESLint-based check returned zero diagnostics as if the code were clean.

  - `orchestrate` returns two new fields, `failures` and `skippedRules`. A failure (`ToolFailure`) is one of `spawn-failed`, `timeout`, `signal`, `exit-code`, `unparseable-output`, `file-not-checked` or `missing-dependency`. Exit codes 0 and 1 are successful runs for both ESLint and ruff; any other code, a signal, or empty or non-JSON output is a failure. A missing `ruff` or `npx`, or non-JSON output, used to make `orchestrate` throw; it now resolves with a failure.
  - The ESLint runner resolves the TypeScript parser and each rule's plugin from the project and imports them by absolute path. A rule whose plugin is not installed is left out and listed in `skippedRules`. Without a TypeScript parser, ESLint is not run and a `missing-dependency` failure names the package. ESLint runs as `npx --no -- eslint`, so npx no longer downloads an ESLint the project lacks.
  - `generateEslintConfig` emits style-profile's `info` tier as `warn`.
  - ESLint parse errors and ignored files, ruff syntax errors, and paths ruff could not read (reported by ruff only on stderr, with exit 0) are `file-not-checked` failures. `parseRuffJsonOutput` leaves out syntax errors: `"code": "invalid-syntax"` (ruff 0.16.8) used to become an ordinary diagnostic in category `other`, and a null `code` (ruff 0.9.10) threw a `TypeError`.

- 5fb8bcd: Add `@titan-design/style-checker`, ported unchanged from codewatch's checker: `generateRuffConfig` and `generateEslintConfig` from a style profile, `orchestrate` to run ruff and ESLint over files, `parseEslintJsonOutput`, `parseRuffJsonOutput` and `formatDiagnostic` to normalize their output, and `diffAgainstProfile` (moved down from codewatch's CLI) to compare style-analyzer observations with a profile.

### Patch Changes

- Updated dependencies [0922be1]
- Updated dependencies [95fc0d6]
- Updated dependencies [94fdafc]
- Updated dependencies [39f1512]
  - @titan-design/style-analyzer@0.1.0
  - @titan-design/style-profile@0.1.0
