---
"@titan-design/factory": patch
---

When update-branch returns but the PR head has not moved within the wait, land re-reads the PR and re-sends the update, up to two times. A head that still has not moved ends the run with the named stop `update-branch-unmoved` instead of a generic step failure.
