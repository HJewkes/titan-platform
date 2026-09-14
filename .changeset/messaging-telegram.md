---
"@titan-design/messaging": minor
---

Add a Telegram Bot API adapter beside the BlueBubbles one: `TelegramTransport`
over `sendMessage`, a `pollUpdates` long-poll iterator with offset tracking,
`validateTelegramWebhook` over the echoed secret header, and
`probeTelegramLiveness` via `getMe`. The send error taxonomy gains a `too-long`
kind for the Bot API's 4096-character text cap.
