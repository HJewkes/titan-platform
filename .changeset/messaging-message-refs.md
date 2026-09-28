---
"@titan-design/messaging": minor
---

Add message identity (TP-289). A successful send now carries a `MessageRef`
(`{ channel, chat, messageId, threadId? }`) beside the deprecated
`messageGuid`, so a later edit or reaction addresses the message by the
resolved chat and never re-runs `chatIdFor`. Every typed inbound update now
carries `messageId` and an optional `threadId`; a typed message adds
`replyToMessageId`, and a tap adds `messageText` and `buttons`, the tapped
prompt's own inline keyboard minus any button without `callback_data`.
`refOfInbound` builds the ref for an inbound update.

Additive for consumers. One behaviour note: a Telegram `message` without
`message_id` no longer parses, which rejects nothing the Bot API sends.
