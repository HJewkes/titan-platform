---
"@titan-design/factory": patch
---

serve reads the bot token from `BOT_TOKEN_PATH`, now `~/.config/titan-factory/secrets/github-bot.token` under the home dir in serve's passwd entry (TP-3094 option B). The README documents the owner's token write and the accepted same-user residual.
