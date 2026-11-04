---
"@titan-design/yt-scout": minor
---

Add `titan-yt-scout transcribe` (TP-4378, Y-15 slice S3). It runs extract.py one video at a time with a persistent circuit breaker on HTTP 429, the no-captions and live retry schedule, and a Whisper gate on queue length and load.
