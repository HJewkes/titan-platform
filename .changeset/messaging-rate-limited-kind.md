---
"@titan-design/messaging": minor
---

Add a `rate-limited` `SendError` kind (TP-288). A 429 from either backend now
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
