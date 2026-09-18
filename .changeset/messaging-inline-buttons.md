---
"@titan-design/messaging": minor
---

Add channel-neutral `buttons` to `SendInput`, rendered by Telegram as an inline keyboard and refused with `bad-buttons` over 64 bytes of callback data.
`pollUpdates` and `validateTelegramWebhook` now yield a `TelegramInbound` union that includes button taps, and `answerCallbackQuery` is exported.
