---
"@titan-design/factory": patch
---

The basement fixer brief now tells fixers to start `basement-suite` as a background task and wait for its completion notice, because a foreground Bash call stops at 10 minutes and the suite runs longer. They send their report after the suite finishes, or report "suite: pending" with the run id if their turn must end first.
