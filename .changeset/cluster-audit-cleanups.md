---
'@titan-design/cluster': patch
---

The generic `SHA` mask now requires a hex letter and a digit, so long decimal numbers resolve to `<NUM>` and all-letter hex words such as "defaced" stay unmasked. Template ids for lines containing either may change. Comments are rewritten in package terms, `toolType` parameters are renamed `partition`, and the unused `options` field on `Clusterer` is gone.
