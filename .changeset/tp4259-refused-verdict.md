---
"@titan-design/fix-proof": minor
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

Give the fix-proof result line a `refused` verdict for a PR whose base is not the default branch (TP-4259). A refused line names the PR's `base` and the `defaultBranch` in fields of their own, with no count and no test, so no reader parses a message to find a refusal. Every judged line may also carry the `base` it judged; `fix-proof judge` takes it as `--base-ref`, and `fix-proof-run.sh` passes it from the workflow's `BASE_REF`. A reader that predates either field rejects the line, so it fails closed.

The review panel counts a refused line as a bad fix-proof, as it did the error line that carried the refusal before.

Shepherd's fix-proof read binds a run to the PR only when GitHub lists it on the PR's base and its line, if it names a base, names that same base. A run GitHub lists on main after a retarget, whose line judged the stacked parent, no longer counts as a second run on main. A job log that cannot be read is read again on the next poll and is an error at the deadline. A run's distrust is settled before its verdict is read. A refused line's standing is `refused`, and the MERGE evidence records the base the line judged as `proofBase`.
