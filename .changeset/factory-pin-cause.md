---
"@titan-design/factory": patch
---

Add the pure pin-differs cause classifier for the marker shadow diff (TP-3111 S2b): `pinCause` turns a reviewed and a current diff pin, a merge-up proof and a whitespace-blind core comparison into `carry-agrees` or a `pin-differs` cause. Nothing calls it yet.
