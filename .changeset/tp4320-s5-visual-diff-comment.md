---
"@titan-design/factory": patch
---

The Shepherd evidence comment gains a Visual diff section when `shepherd.visualThreshold` measured the head (TP-4320 S5). It states the mode, threshold, pixel tolerance and merge base, then a table of snapshots grouped by component with each change and whether it is over the threshold, then the public API, token and harness paths. Removed and unmeasured snapshots read as failing closed. In shadow mode a line says whether `on` would clear the head or what it would gate on. A malformed stored delta reads as unmeasured. The shepherd guide documents the key's modes, metric, rules, caps and coverage gap. The merge decision is unchanged.
