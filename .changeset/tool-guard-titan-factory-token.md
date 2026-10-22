---
"@titan-design/tool-guard": patch
---

The secret list gains `**/titan-factory/**/*.token`, so a Read, cat, cp or base64 of a titan-factory token file (for example `~/.config/titan-factory/secrets/github-bot.token`) classifies as secret-read. Other files under `titan-factory` stay unclassified.
