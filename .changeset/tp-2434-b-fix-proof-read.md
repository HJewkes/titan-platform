---
"@titan-design/factory": patch
---

Shepherd's `sh-fix-proof` read fails closed on reads a head can force: a completed run with no result line for the head, a fix-proof run still incomplete at the deadline, and a missing run on a PR that touches the fix-proof harness (or whose changed files cannot be read in full) now read as `error` instead of `missing`. A new pure `fixProofStanding` maps an `error` result, an `untrusted` read and an `error` read to an unverified reason; reviewPhase wiring follows in TP-2434 c.
