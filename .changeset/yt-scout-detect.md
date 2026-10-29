---
"@titan-design/yt-scout": minor
---

Add `titan-yt-scout detect [--dry-run]` (TP-4377, Y-15 slice S2). It polls each source's RSS feed, falls back to a yt-dlp flat listing with a `fallback` step row when RSS fails, keeps only matching search hits, skips ids already in `videos`, and files shorts, live, upcoming and over-long videos under their filtered state.
