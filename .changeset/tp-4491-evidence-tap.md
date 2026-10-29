---
"@titan-design/factory": minor
---

A console tap can now answer an owner-at-head merge gate (ci-policy-weakened, ci-policy-malformed, skill-path). A ready `gate.ownerEvidence` card carries a sha256 digest of its body, and the tap's record carries that digest as `evidenceDigest`. The factory reads the card again from the same stored evidence and resolves only when the digest matches and the gate and PR are still at the confirmed head. A resolved outcome names the facts the tap covered. A tap with no digest is refused `class` with the terminal command, a changed or missing card is refused `evidence`, and a digest on a gate that needs no evidence is refused `record`.
