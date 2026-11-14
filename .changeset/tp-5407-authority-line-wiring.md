---
"@titan-design/factory": patch
---

Wire the adversary's `Authority:` line into the `owner-tier` merge guard row (TP-5407, gate model S3b). The panel carries the adversary member's accepted Authority value onto its MERGE, and when the run owes an adversary (the panel planned one, or the registration holds a `g10-adversary` hold) the merge evidence stamps `authorityLine`: the value, or `missing` when none was carried or the registration was unreadable. `widened` and `missing` add the owner-tier rows `Authority widened` and `Authority line missing`, which gate under `shepherd.gateReset.ownerTier: on` and are only recorded under shadow; `unchanged` and `tightened` add nothing. The risk tier records `Authority line missing` as high beside `Authority widened`.
