---
"@titan-design/factory": minor
---

Serve's bot identity (TP-3094 C3): `openBotIdentity` reads the bot token through `trackSecretFile` from the code-fixed `BOT_TOKEN_PATH` (undefined until the owner ratifies a path), builds an `octokitClient` with its own `throttleId` and `RateBudget`, and hands it only to the workflow capability `github-bot`. An absent or refused file disables only the bot: serve starts, bot steps get `blocked` with no client, and `/health.bot` reports `{ state: "ok" | "absent" | "refused", problem? }`. The systemd unit gains `LimitCORE=0`.
