---
"@titan-design/factory": minor
---

Every gate the factory opens now carries a summary naming the head, an evidence link and, where the answer is a choice, a question menu built from the same option list as the answer schema (TP-1198). The host requires a brief (`requireBrief`) after running the gate brief migration at version 13, so a gate site without one fails its run with `GateBriefInvalid`. `titan-factory` prints the summary, evidence and recommended option for a pending gate, and falls back to the prompt for a gate opened before the migration.
