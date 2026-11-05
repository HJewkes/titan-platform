---
"@titan-design/factory": minor
---

Split the console-action route into `console-action/{route,record,outcome,gate,release,op}.ts` and teach it typed owner ops (TP-3939 S2). A record that names an `op` (the owner-queue `OwnerOp`) instead of an `action` is checked against the authority table as owner-remote: a denied op is refused 403 `class`, an unknown kind 422 `record`. An admitted op runs its kind's effect between a `started` and a `done` line in the new `<stateDir>/owner-ops.jsonl` ledger; no kind has an effect yet, so every op is still refused `class`. Existing resolve-gate and owner-release records read and answer as before. New read command `owner-op.preview` returns an op's authority decision and the live PR (GitHub and Shepherd) or gate it names.
