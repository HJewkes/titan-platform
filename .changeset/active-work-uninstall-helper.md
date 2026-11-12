---
"@titan-design/active-work": patch
---

Split the repeated confirm, run, or skip blocks of `runUninstall` into one shared helper. Prompts, their order, and the reported steps are unchanged, and a new test file pins each confirm yes, no, and cancel path.
