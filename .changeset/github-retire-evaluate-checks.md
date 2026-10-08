---
"@titan-design/github": minor
---

Remove `evaluateChecks` and the `ChecksVerdict` type. It counted `skipped` and `neutral` as passed for a required check, which disagreed with `headCheckFindings` and `mergeReadiness`, where a required context needs a completed `success` run. Use `mergeReadiness` (or `headCheckFindings`) as the one rule. `isPassing` and `latestPerName` are unchanged.

Importers checked before removal, `git grep -E 'evaluateChecks|ChecksVerdict'` on each default branch: titan-platform origin/main f4b073d4 (only prose in changelogs, no code importer), active-work d30d9562: 0, agent-chat 93838463: 0, codewatch dc9f4eff: 0, relay e7a47577: 0, brain 760ce01a: 0.
