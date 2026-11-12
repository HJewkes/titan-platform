---
"@titan-design/factory": patch
"@titan-design/coordinator": patch
---

Hold a low-tier policy touch `g10-review` instead of `g10-adversary` (TP-5403 slice B), so it lands on one opus MERGE at its head with green CI and no owner gate. The release records the rule `g10-review/low-tier`, the timeline shows it as a `decision` entry, and the merge evidence records `lowTier`. The live switch `shepherd.gateReset.lowTierPolicy` (off, shadow, on; absent means on) is a new editable factory row.

The files that define the low-tier refusal's own inputs (`signoffs.ts` and review-panel's `classify.ts`) never go low, so an edit that could weaken the gate stays `g10-adversary`.
