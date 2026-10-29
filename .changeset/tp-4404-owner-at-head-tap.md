---
"@titan-design/factory": minor
"titan-console": minor
---

The console can answer an owner-at-head merge gate (ci-policy-weakened, ci-policy-malformed, skill-path, files-unread). The factory's new `gate.ownerEvidence` read returns the evidence each fact needs at the gate's pinned head, with a digest: the `.github/` diff against the merge base and the reviewer's verdict text with its `CI-policy:` line, the repo skill diff, or every changed file's diff. The confirm sheet shows that evidence, and the tap posts its digest. The factory resolves only when the tap carries the digest, a fresh read at the same head matches it, and nothing was cut. The resolved outcome names the facts the tap covered. Anything else falls back to the terminal command.
