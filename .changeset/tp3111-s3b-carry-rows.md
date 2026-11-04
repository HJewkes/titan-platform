---
"@titan-design/factory": patch
---

Log each MERGE Shepherd carried live as a marker-shadow carry row at entry end (TP-3111 S3b). The host's new `markerShadow.carryProbe` hook reads both diff pins; the row is `carry-agrees` or `pin-differs` with a cause, and `unprobed` when no probe is set. The carry pass runs after the orphan trap, metered and swallowed, so a failing probe logs `shadow-error` and the run is unchanged. A live miss whose projection equals the newest marker at the previous pin now logs `miss-same-output`.
