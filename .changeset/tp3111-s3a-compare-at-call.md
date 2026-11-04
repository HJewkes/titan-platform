---
"@titan-design/factory": patch
---

Compare each live fact-step call against the marker shadow's verdict (TP-3111 S3a). After the live call, the shadow sends a `compare` event (hit, false-hit, miss or unmarked, with material and full validity) and the log sink writes it as one row. A memo hit sends none. The compare is swallowed and metered like the rest of the shadow, and the live result is returned unchanged.
