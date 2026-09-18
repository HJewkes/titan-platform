# @titan-design/messaging

## 0.2.0

### Minor Changes

- 6fe74f4: Add channel-neutral `buttons` to `SendInput`, rendered by Telegram as an inline keyboard and refused with `bad-buttons` over 64 bytes of callback data.
  `pollUpdates` and `validateTelegramWebhook` now yield a `TelegramInbound` union that includes button taps, and `answerCallbackQuery` is exported.

## 0.1.0

### Minor Changes

- 54a06d1: Add a Telegram Bot API adapter beside the BlueBubbles one: `TelegramTransport`
  over `sendMessage`, a `pollUpdates` long-poll iterator with offset tracking,
  `validateTelegramWebhook` over the echoed secret header, and
  `probeTelegramLiveness` via `getMe`. The send error taxonomy gains a `too-long`
  kind for the Bot API's 4096-character text cap.
- 8408c84: Add the messaging package: a one-method `MessageTransport` contract with a typed
  error taxonomy, a fetch-only BlueBubbles iMessage adapter, an in-memory mock
  transport, a pure inbound-webhook validator with an injected dedupe store, and a
  liveness probe for the dark-coach-session case.
