---
"@titan-design/factory": patch
---

TP-3107 S2 adds the marker pin encoders. `markers/pins.ts` exports `pinFor(fact, item, sources, now)`. It returns a fact's tree pin (`<head>@e<epoch>`, read from the head epoch), its diff pin (`DiffPin.full`, from an injected source), its observed pin (the newest producer-kind seq per subject), its TTL pin (`ttl`, with `expiresAt`) or its landed pin (the merge commit's tree, the `merge_op` id, and the `Reverted` seq). A fact it cannot pin gets a reason, and S3 treats that fact as ABSENT. The event log gains `newestSeq(db, { subject, kinds })`. Both no-consumer guards now admit exactly `markers/pins.ts` as their first registered consumer. Nothing calls `pinFor` yet.
