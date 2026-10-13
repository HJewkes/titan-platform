---
"@titan-design/review-panel": minor
---

`acceptVerdict` refuses a MERGE whose CI-policy line reads malformed with the new `ci_policy_malformed` refusal, so the reviewer gets one correction turn instead of the merge guard gating the PR. The brief and correction prompt state that the line holds nothing else, and `MAX_CORRECTION_PROMPT_CHARS` rises from 1500 to 1600 to fit that sentence. A binary older than this release reads a stored `ci_policy_malformed` record as no record and sends the PR to a fresh reviewer.
