---
"@titan-design/render-qa": minor
---

Add `mediaScan(video, { exec? })`: black (`BLACK_MIN_S`), silent (`SILENCE_NOISE_DB`, `SILENCE_MIN_S` 2 s) and frozen
(`FREEZE_MIN_S`) stretches of a video from one ffmpeg pass of blackdetect, silencedetect and freezedetect, and
`parseMediaScan` for the stderr log alone. `spawnFfmpeg` takes `read: 'stderr'` to yield the log instead of stdout.
