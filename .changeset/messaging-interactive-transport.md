---
"@titan-design/messaging": minor
---

Add `ChannelCapabilities` and `InteractiveTransport` (TP-290). The new
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
