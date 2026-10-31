---
"@titan-design/evals": minor
---

TP-1144e2: add the implement-task export orchestrator. `exportImplementTaskCases` selects candidates, filters private ones, screens each class in seeded order until `perClass` fills or the pool ends, then writes the kept cases, `suite.json` (`implement-task-private`, `checks: []`) and `manifest.json`, and removes `.scratch` even on a throw. `selectExportPool` is the selection step alone.
