---
"@titan-design/factory": patch
---

Shepherd's merge guard reads the reviewer's `CI-policy:` line (TP-2407 b): `weakened` gates any PR on `shepherd-merge-guard/ci-policy-weakened`, a present but malformed or repeated line gates any PR on `shepherd-merge-guard/ci-policy-malformed`, and a `.github/` change with no line gates on `shepherd-merge-guard/github-path`. The line survives re-reads, carried MERGEs and external reviews.
