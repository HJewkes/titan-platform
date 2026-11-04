---
"@titan-design/factory": patch
---

A workflow-only PR whose fix-proof says NO_REPRO now goes straight to the owner's waivable `sh-sent-back` gate instead of waking a fixer. Its CI proof needs a required check red at the merge base, which no push to the PR can make, so the wake always ended at that gate (tp#2325). A run recorded before this replays its fixer wake as it ran. The send-back route moves from `pr.ts` to `shepherd/send-back.ts`.
