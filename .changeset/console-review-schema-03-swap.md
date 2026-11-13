---
"titan-console": patch
---

The console reads rounds with the published review-schema 0.3 and drops its vendored copy. The approvals queue passes 0.3 rounds and feedback straight to owner-queue, which now reads 0.3 too, so a round or feedback that only 0.3 knows is no longer a gap (TP-3232).
