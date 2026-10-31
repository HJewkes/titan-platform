---
"@titan-design/factory": patch
---

Shepherd merges main into a green PR itself, through land's own update-branch, when main changed a guard or policy file (the stage-version and index-version guards, `.github/fix-proof.json`, the dead:check script and its baselines) since the PR's merge base, or when an approve-merge gate's only unmet MRG-AU condition is `no-non-green-run` and main's tip is green. A conflicting merge falls back to the existing conflict fix-round wake. `land` takes the new `mergeBaseFirst` option for this.
