# @titan-design/messaging

## 0.4.0

### Minor Changes

- 55caef2: Add `ChannelCapabilities` and `InteractiveTransport` (TP-290). The new
  interface extends `MessageTransport` with a static `capabilities` descriptor
  and four methods that act on a message that already exists: `react`,
  `chatAction`, `edit` and `answerAction`. None of them throws; each answers
  `{ ok: true, changed }` or `{ ok: false, error }`, where `error` adds
  `unsupported` (naming the missing capability) and `message-gone` to
  `SendError`. An edit Telegram calls "not modified" is `{ ok: true, changed:
false }`, so a repeat tap is a quiet no-op.

  `MessageTransport` is unchanged, so a consumer's own one-method fake still
  compiles. `createTelegramTransport` and `createBlueBubblesTransport` now return
  the subtype. BlueBubbles answers `unsupported` for all four and makes no
  request.

  `Button` gains `state?: "disabled"` and `style?: "primary" | "success" |
"danger"`. Both render only where `capabilities.buttonStates` is true, which
  Telegram leaves false until a spike confirms the Bot API 9.4 `style` and 10.3
  `disabled` wire shapes; `TelegramConfig.buttonStates` turns them on.

  An `edit` with neither `text` nor `buttons` now fails `bad-buttons` before any
  call, on Telegram and on `MockTransport` alike, instead of Telegram sending an
  `editMessageReplyMarkup` with no `reply_markup`.

- 55caef2: Add message identity (TP-289). A successful send now carries a `MessageRef`
  (`{ channel, chat, messageId, threadId? }`) beside the deprecated
  `messageGuid`, so a later edit or reaction addresses the message by the
  resolved chat and never re-runs `chatIdFor`. Every typed inbound update now
  carries `messageId` and an optional `threadId`; a typed message adds
  `replyToMessageId`, and a tap adds `messageText` and `buttons`, the tapped
  prompt's own inline keyboard minus any button without `callback_data`.
  `refOfInbound` builds the ref for an inbound update.

  Additive for consumers. One behaviour note: a Telegram `message` without
  `message_id` no longer parses, which rejects nothing the Bot API sends.

- 55caef2: Teach `MockTransport` the acknowledgement surface (TP-291). It now implements
  `InteractiveTransport`: an ordered `log` of every call with the time it
  happened, `messageAt(ref)` for what the person would see now,
  `typingVisible(handle)` for five seconds on the injected clock or until the
  next send, and a partial `capabilities` override so each degrade path is
  testable. `failNext` takes an optional method name, so a rate-limited reaction
  does not fail the reply after it, and an `InteractionError` as well as a
  `SendError`.

  Adds `ManualClock`, a `Scheduler` whose time moves only on `advance(ms)`, and
  `fakeTextUpdate` / `fakeCallbackUpdate`, which build raw Bot API JSON so a door
  under test still runs the real parser.

  `sent`, `reset` and `failNext(error)` keep their 0.3.0 behaviour, and the
  constructor still takes a bare clock function.

  `MockTransport` reports `buttonStates: false` by default, matching Telegram, so a test sees the degraded path unless it passes `capabilities: { buttonStates: true }`.

- 55caef2: Add a `rate-limited` `SendError` kind (TP-288). A 429 from either backend now
  arrives as `{ kind: "rate-limited", retryAfterSeconds?, message }` instead of
  `{ kind: "rejected", status: 429 }`. On Telegram the seconds come from
  `parameters.retry_after`, falling back to the "retry after N" text of the
  description; when neither names a wait the field is absent and the consumer
  picks its own backoff, because the package never invents a number. BlueBubbles
  names no wait, so its 429 carries no seconds.

  Source-breaking for an exhaustive switch over `SendError`: relay's
  `dispositionOf` (`worker/src/telegram-send.ts`) stops compiling until it adds a
  `rate-limited` arm, and its `error.status === 429` arm and `retryAfterMs` regex
  go dead. That is the intended effect of that switch, and it follows the 0.3.0
  precedent for `indeterminate`. A caret on a 0.x version does not cross a minor,
  so the break is opt-in.

  Also adds a single private `callBotApi` path for every Telegram method, so the
  token cannot reach a string by a new route, and widens
  `AnswerCallbackResult`'s failure with the same typed `error`.

  `parameters.retry_after` and the description-text fallback share one
  validator: zero, negative, non-numeric, `NaN` or infinite is treated as
  absent, a fraction rounds up to a whole second, and a value above the exported
  `TELEGRAM_MAX_RETRY_AFTER_SECONDS` (86,400, one day) is clamped to it, because
  the wait is real and only its size is untrusted.

- 29960f2: Add `splitText`, a pure splitter that breaks long text at paragraph, newline, sentence or whitespace boundaries within a UTF-16 limit, never splits a surrogate pair, and closes and reopens code fences at a break.

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
