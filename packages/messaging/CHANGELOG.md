# @titan-design/messaging

## 0.3.0

### Minor Changes

- 128fc60: Split "not sent" from "maybe sent" on `send`. `SendError` gains an `indeterminate` kind for a failure after the request may have reached the server: a reset or closed socket, a timeout or abort while awaiting the response, an unknown error shape, or a 2xx whose body could not be read. `unreachable` now means the request provably never left (DNS failure, refused connection, connect timeout, a request that could not be built), so it is the one kind that is safe to retry automatically. Breaking for exhaustive switches over `SendError["kind"]`: add an `indeterminate` arm and do not auto-resend on it.

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
