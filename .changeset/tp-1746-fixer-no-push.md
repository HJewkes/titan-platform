---
"@titan-design/factory": patch
---

A woken Shepherd fixer that exits without pushing a new head no longer leaves the run waiting for one. When every failing test file is outside the PR's diff, the failed jobs are rerun once at that head; otherwise the sent-back gate opens naming the fixer's exit.
