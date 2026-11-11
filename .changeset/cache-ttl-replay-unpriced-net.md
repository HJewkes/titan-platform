---
"@titan-design/session-analytics": patch
---

`cacheTtlWhatIf` replays 5m sessions over every request, priced or not, so an unpriced middle request no longer hides a rebuild. It also reports `reversePremiumUsd` and `reverseNetUsd` per role and profile: the replay saving less the 1h-over-5m premium on the writes it keeps.
