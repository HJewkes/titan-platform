---
"@titan-design/factory": patch
---

Move the visual-packet and diagnosis spawn ports into a `spawn-ports.ts` leaf, and `HOLD_POLL_MS`, `HeldCheck`, `HoldTiming` and `TakeRecheck` into a `hold-timing.ts` leaf, so phases.ts, train.ts and merge-order-steps.ts no longer reach the spawn steps or hold.ts, and lower the import-cycle ceiling to 30. A pure move; no behaviour change.
