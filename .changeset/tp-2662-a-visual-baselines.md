---
"@titan-design/factory": patch
---

`decideAutoMerge` takes optional `visualBaselines { check, paths }` (also on `MergeEvidenceInput`). A head whose changed files match `visualPaths` gates on `shepherd-merge-guard/visual-path` naming the baseline files when it adds, changes or removes a file under `paths`; with no baseline change and the named check at `success` from GitHub Actions at the head it clears, and the allow reason records the clearance. Any other check state, or no `visualBaselines`, keeps the glob gate (TP-2662 a).
