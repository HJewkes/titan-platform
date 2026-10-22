---
"@titan-design/factory": patch
---

Shepherd's G10 release counts a non-strict stale-green CI read (`behind` with `baseMoved` and the head's own checks green) as green, as land merges that head as it stands. Before, a two-MERGE `g10-adversary` hold, or a `g10-review` hold, on a base whose land rules are not strict never released once main moved past the head's green (TP-3933).
