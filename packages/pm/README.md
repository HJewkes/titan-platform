# @titan-design/pm

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Exports `TaskSchema` (zod) and its inferred `Task` type: the task record active-work
stores, one YAML file per task. Also exports `readEdges` and `checkEdges` for a task's
parent and dep edges, and `CategoryRegistrySchema`, `categoriesPath` and
`checkCategories` for the closed kind, status, cos and area categories, and
`DeliverableSchema`, `deliverablesDir` and `parseDeliverableRegistry` for the
deliverable registry, and `summaryRecommendations`, `prioritizedTopics`,
`parseDispositions` and `checkDispositions` for the repo-review disposition gate, and
`isAgentVisible` and `InitiativeVisibilitySchema` for an initiative brief's `visibility`, and
`OutcomeSchema`, `BetSchema`, `FreezeSchema` and `OutOfScopeSchema` for planning records, and
`TaskRequireSchema` for a brief's `task_require` list of the task provenance fields (`class`,
`serves`, `source` and the rest, typed in `src/provenance.ts`) new tasks must carry. The root entry is pure code: no fs, process or network. The `./node`
subpath holds the planning-record file store (`readPlanRecord`, `loadPlanRecords`,
`writePlanRecord`, `withPlanLock`). See
`site/reference/pm.md`.

The first npm publish is pending and owner-only; trusted publishing is set up after it.
