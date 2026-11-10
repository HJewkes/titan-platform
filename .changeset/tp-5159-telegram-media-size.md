---
"@titan-design/messaging": patch
---

Telegram `sendPhoto` and `sendVoice` now refuse a file over the Bot API upload limit (10 MB for a photo, 50 MB for a voice note) with a `too-long` error before any request, instead of uploading it to be rejected.
