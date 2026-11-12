---
"@titan-design/yt-scout": patch
---

Make the digest step robust (TP-4440): the daily cap skips a malformed row line instead of throwing, and the task retriever runs `active-work search --json` and reads the envelope's `data.hits`.
