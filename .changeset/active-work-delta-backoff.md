---
"@titan-design/active-work": patch
---

A failing session-index delta pass now backs off, doubling per failure up to the maximum, instead of retrying on every reader call. Until the deadline readers get `stale` without a pass starting; a successful pass clears the backoff. Lock-contention deltas and the full-pass backoff are unchanged.
