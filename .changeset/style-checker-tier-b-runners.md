---
"@titan-design/style-checker": minor
---

Add Tier B Python audit runners: `runVultureAudit`, `runPydoclintAudit`, `runPyrightAudit` (with `AUDIT_PYRIGHT_RULES` and `generatePyrightAuditConfig`), `runImportLinter`, and the pure `countSuppressions`, `findSuppressions` and `suppressionTotals`. Each runner reports stable `<tool>/<rule>` ids and paths relative to `cwd`, and returns an empty result with an install hint in the new optional `RunnerResult.warnings` when its tool is not installed. `ToolName` gains `vulture`, `pydoclint`, `pyright`, `import-linter` and `suppressions`.
