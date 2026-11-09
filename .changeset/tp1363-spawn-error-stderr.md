---
"@titan-design/github": patch
---

`execGh` and `execGit` now put the spawn error message in `stderr` when the binary cannot start (ENOENT, EACCES), so a `GhError` names the cause instead of reading `failed (1): ` with no detail. A command that runs and exits non-zero keeps its code and stderr.
