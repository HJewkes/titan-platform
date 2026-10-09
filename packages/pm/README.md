# @titan-design/pm

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports `TaskSchema` (zod) and its inferred `Task` type: the task record active-work
stores, one YAML file per task. Also exports `readEdges` and `checkEdges` for a task's
parent and dep edges. Pure code: no fs, process or network. See
`site/reference/pm.md`.

The first npm publish is pending and owner-only; trusted publishing is set up after it.
