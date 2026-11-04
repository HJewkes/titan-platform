---
"@titan-design/session-miner": patch
---

Row reads, JSON envelopes and the lock file in session-miner are now narrowed with zod schemas instead of type assertions; three assertions with no runtime schema stay baselined. No change to command output.
