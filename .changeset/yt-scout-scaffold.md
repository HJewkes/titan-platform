---
"@titan-design/yt-scout": minor
---

Add `products/yt-scout`, the scheduled AI-video scout (TP-4372, Y-15 slice S1). `titan-yt-scout config check` validates the owner's watch list against a strict schema and names the line of each problem; `titan-yt-scout seen import` loads the pre-scout inventory, scores, watch-later picks and transcript ids into the SQLite `videos` table, and a rerun adds nothing. Detect, transcribe and score are typed seams for later slices.
