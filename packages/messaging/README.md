# @titan-design/messaging

Send a text message to a handle, and validate the webhook that comes back. The
transport is one method wide — `send({ handle, text })` — so the scheduler, the
protocol state machine and the composer above it never see a vendor SDK.

Tier 1 of the titan-platform DAG (TP-59). No package dependencies; `zod` is a
peer (v4). The core is **fetch-only**: no `node:` imports anywhere, so the same
build runs in a Cloudflare Worker, in a daemon, and under vitest.

## Send

`BlueBubblesTransport` talks to a [BlueBubbles Server](https://bluebubbles.app)
over its REST API. iMessage cannot open a conversation from an API call, so the
chat GUID is resolved by the caller and a handle with no existing chat is a
typed `no-chat` failure, not an exception.

```ts
import { createBlueBubblesTransport } from "@titan-design/messaging";

const transport = createBlueBubblesTransport({
  baseUrl: "http://127.0.0.1:1234",
  password: config.bluebubblesPassword,   // never read from env by this package
  chatGuidFor: (handle) => chats.get(handle),
});

const result = await transport.send({ handle: "+15550000000", text: "sunday?" });
if (!result.ok) {
  switch (result.error.kind) {
    case "no-chat":       // a human must send the first message to this handle
    case "unreachable":   // provably never sent; safe to retry (see Retry semantics)
    case "indeterminate": // may have been delivered; never resend automatically
    case "unauthorized":  // wrong server password
    case "rejected":      // 4xx, result.error.message is the server's own text
    case "rate-limited":  // 429; retryAfterSeconds when the server named a wait
    case "unknown":       // 5xx or a thrown chatGuidFor
  }
}
```

`ok: true` means the server accepted the message for sending. Nothing more:
there is no delivered or read signal (see below). Errors, including the ones
raised by `fetch` itself, are redacted before they leave the transport, so the
server password never reaches a log line, a thrown error, or a result object.

### Message identity

A successful send also carries a `MessageRef`: `{ channel, chat, messageId }`,
plus `threadId` when the channel has one. It is plain JSON, so a product stores
it as is and hands it back to address a later edit or reaction. The pair
(`chat`, `messageId`) is the identity, because a Telegram `message_id` is only
unique within one chat, and the ref holds the **resolved** chat, so an edit
never re-runs `chatIdFor` and cannot land somewhere else if the handle map
changed. That pair is the key a message store should use; this package stores
nothing itself and a store should record at least the ref, the text, the
buttons sent and who the message was for.

`ref` is absent when the server accepted the message without naming it, so
treat it as optional. `messageGuid` still carries the bare id and is deprecated.

`refOfInbound(update)` gives the same ref for something that arrived: the
person's own message for a typed update, and the tapped prompt for a tap.

### Retry semantics

A failed send is either "not sent" or "maybe sent", and only the first is safe
to resend without asking anyone. The kinds split like this:

| Kind | Safe to auto-retry | Why |
|---|---|---|
| `unreachable` | **Yes** | The request provably never left: DNS failure, refused connection, connect timeout, or a request that could not be built (a malformed base URL) |
| `rate-limited` | **Yes**, after the server's backoff | Rate limiting refuses the request before acting on it |
| `indeterminate` | **No** | The request may have reached the server: a reset or closed socket, a timeout or abort while awaiting the response, an error shape the classifier does not recognise, or a 2xx whose body could not be read |
| `unknown` | **No** | A 5xx can follow work the server already did; a thrown `chatGuidFor` or `chatIdFor` also lands here and needs a fix, not a retry |
| `rejected`, `unauthorized`, `no-chat`, `too-long`, `bad-buttons` | **No** | The same request fails the same way; fix the input or the configuration |

A 429 from either backend is `rate-limited`, never `rejected`. On Telegram
`retryAfterSeconds` comes from `parameters.retry_after`, or from the "retry
after N" text of the description when the envelope omits it. When neither names
a wait the field is absent and the consumer picks its own backoff: the package
never invents a number. BlueBubbles names no wait, so its 429 always arrives
without seconds.

On `indeterminate`, record the message as "maybe sent" and stop: tell a human,
or let a later message supersede it. Resending is what delivers it twice.

Only a thrown `fetch` whose `cause` chain carries `ECONNREFUSED`, `ENOTFOUND`,
`EAI_AGAIN` or `UND_ERR_CONNECT_TIMEOUT` (Node's undici) counts as
`unreachable`. Everything else, including every `AbortError` and
`TimeoutError`, is `indeterminate`: the error cannot say whether the request
was written first. Cloudflare Workers and other runtimes throw errors with no
code, so there nearly every network failure is `indeterminate`. That costs
some retries that would have been safe; it never costs a duplicate.

Neither backend offers a dedupe key that makes a resend safe. BlueBubbles
refuses a `tempGuid` only while the first send with it is still in flight and
forgets it once that send settles, so a retry after a timeout sends again.
Telegram's `sendMessage` has no idempotency key. Deduplication therefore
belongs to the consumer's own ledger, not to this stateless adapter.

`MockTransport` implements the same contract in memory. It records every send,
including one it was scripted to fail, so a consumer can test its retry and
ceiling logic with no Apple ID and no server:

```ts
const transport = new MockTransport();
transport.failNext({ kind: "unreachable", message: "dark" });
transport.failNext({ kind: "indeterminate", message: "reset after write" });
await transport.send({ handle: "+15550000000", text: "one" }); // recorded, failed, retry it
await transport.send({ handle: "+15550000000", text: "two" }); // recorded, maybe sent, do not
```

### Testing an acknowledgement

`MockTransport` implements `InteractiveTransport` too. `log` is every call in
order with the time it happened, `messageAt(ref)` is what the person would see
now, and `typingVisible(handle)` is true for five seconds on the injected clock
or until the next send to that handle. `capabilities` takes a partial override,
so each degrade path is testable:

```ts
import { fakeTextUpdate, ManualClock, MockTransport } from "@titan-design/messaging";

const clock = new ManualClock(0);
const transport = new MockTransport({
  now: () => clock.now(),
  capabilities: { reactions: false },     // the channel that cannot ack
});

await door(fakeTextUpdate({ text: "ate it" }), transport);
transport.log[0];                          // { type: "send", at: 0, ... }
```

`failNext(error, on?)` scopes a scripted failure to one method, so a
rate-limited reaction can be tested without failing the reply that follows it.
A capability that is off answers `unsupported` before the queue is touched.
`fakeTextUpdate` and `fakeCallbackUpdate` build raw Bot API JSON, so a test
feeds a door the same bytes Telegram would and the real parser still runs.
`ManualClock` is a `Scheduler` whose time only moves when `advance(ms)` is
called.

## Acknowledging a message

`MessageTransport` is still one method wide. Everything that acts on a message
that already exists lives on `InteractiveTransport`, which extends it, so a
consumer's own one-method fake still satisfies the send contract. Both shipped
adapters implement it, and both factory functions return it.

```ts
import { createTelegramTransport } from "@titan-design/messaging";

const transport = createTelegramTransport({ token, chatIdFor });

if (transport.capabilities.reactions) {
  await transport.react({ to: ref, emoji: "👀" });   // null clears the mark
}
await transport.chatAction({ handle: "lifter", action: "typing" });
await transport.edit({ ref, text: "Logged", buttons: "remove" });
await transport.answerAction({ actionId: tap.callbackQueryId, toast: "Logged" });
```

No method throws. Each answers `{ ok: true, changed }` or
`{ ok: false, error }`, where `error` is a `SendError` plus two cases of its
own: `unsupported`, naming the capability the channel lacks, and
`message-gone`, for an edit of a message that is no longer there. `changed`
matters for `edit`: Telegram answers "message is not modified" when an edit
changes nothing, and that maps to `{ ok: true, changed: false }`, so a repeat
tap or an at-least-once retry is a quiet no-op rather than an error. An edit
with neither `text` nor `buttons` names nothing to change, so it fails
`bad-buttons` before any call; `MockTransport` answers the same way.

`capabilities` is a static, readonly descriptor. It answers "can this channel
do this" so a caller can pick a degrade path before it calls; it never promises
one call will succeed. A flag is true only where the shipped adapter implements
the thing today:

| Field | Telegram | BlueBubbles | Mock default |
|---|---|---|---|
| `maxTextLength` | 4096 | undefined | undefined |
| `canInitiate` | false | false | true |
| `deliveryCeiling` | `accepted` | `accepted` | `accepted` |
| `buttons` | true | false | true |
| `buttonStates` | false, pending a spike | false | true |
| `edits`, `reactions`, `chatActions` | true | false | true |
| `drafts`, `draftStreaming`, `threads` | false | false | false |

BlueBubbles answers `unsupported` for all four methods and makes no request:
tapbacks, typing and edits there all need the Private API, which this package
rules out of scope.

`state: "disabled"` and `style` on a `Button` are rendered only by a channel
whose `buttonStates` is true, the same way BlueBubbles ignores `buttons`
altogether. Telegram defaults to false: the Bot API added `style` in 9.4 and
`disabled` in 10.3, but neither wire shape has been confirmed against a live
bot, so `buttonStates: true` in `TelegramConfig` turns them on for a spike and
the default costs nobody a surprise. `drafts` and `threads` are false because
this adapter has no `draft` method and ignores `threadId` on send.

## Inbound

BlueBubbles publishes no request-signature scheme. The boundary is therefore a
secret path segment, a sender allowlist, a GUID dedupe and a length cap, and
`validateInbound` is the pure function that applies all four. The secret is
compared in constant time; storage for the dedupe is injected, so the validator
needs no database and stays runtime-neutral.

```ts
import { MemorySeenStore, validateInbound } from "@titan-design/messaging";

const seen = new MemorySeenStore(); // swap for a KV- or SQLite-backed SeenStore

const result = await validateInbound({
  pathSecret: url.pathname.split("/").pop() ?? "",
  expectedSecret: env.IMESSAGE_WEBHOOK_SECRET,
  allowedHandles: ["lifter@icloud.com"],
  body: await request.json(),
  maxTextLength: 2000,
  seen,
});

if (result.status === "accepted") {
  await enqueue({ handle: result.handle, text: result.text, guid: result.guid });
}
```

A rejection carries one reason: `bad-secret`, `malformed`, `from-me`,
`sender-not-allowed`, `too-long` or `duplicate`. A rejected GUID is never
recorded, so a genuine retry of a rejected request is still judged on its
merits. `SeenStore { has(guid), add(guid) }` accepts sync or async
implementations; only the in-memory one ships here.

## Liveness

macOS auto-logs in exactly one user at boot, so after any reboot or OS update
the coach session is dark until a human fast-user-switches into it. Dark is an
expected state, not an exception, and every consumer should probe before it
sends.

```ts
import { probeLiveness } from "@titan-design/messaging";

const liveness = await probeLiveness(config, { timeoutMs: 2000 });
if (liveness.state === "dark") {
  alertHuman(liveness.reason); // unreachable | unauthorized | timeout | bad-response
}
```

`alive` carries `serverVersion`, `osVersion` and `privateApi` when the server
reports them. The probe races its own timer and aborts the request it gave up
on, so a hung server cannot wedge a caller's tick.

## Telegram

`TelegramTransport` talks to the [Bot API](https://core.telegram.org/bots/api).
A bot cannot open a conversation either: the person messages the bot first, and
the chat id is resolved by the caller exactly like the BlueBubbles chat GUID.
The token sits in the URL path (`/bot<token>/sendMessage`), so every error,
including the ones `fetch` raises with the URL inside them, is redacted before
it leaves the transport.

```ts
import { createTelegramTransport } from "@titan-design/messaging";

const transport = createTelegramTransport({
  token: config.telegramBotToken,   // never read from env by this package
  chatIdFor: (handle) => chatIds.get(handle),
});

const result = await transport.send({ handle: "lifter", text: "sunday?" });
if (!result.ok && result.error.kind === "too-long") {
  split(result.error.length, result.error.limit); // 4096 characters
}
```

No `parse_mode` is sent, so coach copy is never mangled by Markdown parsing.
`too-long` is checked before the call and is its own `SendError` kind, so a
composer can split rather than retry.

`buttons` on `SendInput` is channel-neutral: rows of `{ label, data }`.
Telegram renders them as an inline keyboard (`reply_markup.inline_keyboard`,
`data` as `callback_data`); BlueBubbles ignores them, since iMessage has no
keyboards, and `MockTransport` records them. Telegram caps `callback_data` at
64 UTF-8 bytes, so a longer `data` or an empty label fails with `bad-buttons`
before any call. That message never quotes a data value. The package does not
interpret `data`; the consumer owns its format (relay uses
`v1|<action>|<slot>|<date>`).

```ts
await transport.send({
  handle: "lifter",
  text: "Lunch?",
  buttons: [[
    { label: "Ate", data: "v1|ate|lunch|2026-09-18" },
    { label: "Skipped", data: "v1|skip|lunch|2026-09-18" },
  ]],
});
```

Inbound arrives either way Telegram offers. `pollUpdates` is the long poll a
daemon runs; it tracks the offset (`last update_id + 1`), acknowledges every
update it saw, yields only text messages and button taps from an allowed chat,
and stops when the signal aborts. Each item is a `TelegramInbound`, told apart
by `kind`: `"text"` carries `text`; `"callback"` carries `data`,
`callbackQueryId` and the `messageId` the button sat on. A tap with no `data`
or no `message` is acknowledged and skipped.

Both kinds carry `messageId`, so anything read here can be reacted to or
edited, and `threadId` when the chat has topics on. A typed update adds
`replyToMessageId`. A tap adds `messageText` and `buttons`: the tapped prompt's
own inline keyboard, read back as the same channel-neutral rows that were sent.
Only buttons with `callback_data` survive that read, because a URL or Web App
button cannot be answered. That is what lets a receipt be built from the tap
alone, with no lookup of what was sent.

```ts
import { pollUpdates, readChatIds } from "@titan-design/messaging";

const chatIds = await readChatIds(config); // one-time: "what is my chat id?"

for await (const update of pollUpdates(config, {
  timeoutSeconds: 30,
  allowedChatIds: [chatIds[0]],
  signal: controller.signal,
})) {
  if (update.kind === "text") {
    await enqueue({ chatId: update.chatId, text: update.text });
  } else {
    await record(update.data);
    await answerCallbackQuery(config, update.callbackQueryId, "Logged");
  }
}
```

Answer every tap with `answerCallbackQuery(config, callbackQueryId, text?)`, or
the button keeps spinning on the phone. `text` shows as a brief toast. It never
throws: it returns `{ ok: true }` or `{ ok: false, reason, error }`, with the
token redacted from both. `error` is the same `SendError` union a send reports,
so a 429 on a toast is `rate-limited` and is backed off rather than re-parsed.

`validateTelegramWebhook` is the push equivalent: same shape as
`validateInbound`, over the `X-Telegram-Bot-Api-Secret-Token` header that
Telegram echoes from `setWebhook`, the same constant-time compare, a chat
allowlist, a length cap on text and an `update_id` dedupe through the same
`SeenStore`. It reads the same two shapes as `pollUpdates`, and an accepted
result is `{ status: "accepted" }` plus the `TelegramInbound` item.
Its rejection reasons are `bad-secret`, `malformed`, `not-text`,
`sender-not-allowed`, `too-long` and `duplicate`.

```ts
const result = await validateTelegramWebhook({
  headerSecret: request.headers.get("x-telegram-bot-api-secret-token") ?? "",
  expectedSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [4242],
  body: await request.json(),
  maxTextLength: 2000,
  seen,
});
```

`probeTelegramLiveness(config, { timeoutMs })` calls `getMe`, the documented way
to test a token, so one probe answers both "does the API answer" and "does this
token still work". It returns the same `alive` / `dark` shape as
`probeLiveness`, with the bot username on `alive`.

## What this package deliberately does not do

- **Secrets.** The server password and the webhook secret are configuration
  values passed in by the caller. Nothing here reads an environment variable or
  a file, and nothing here writes one.
- **Persistence.** The GUID dedupe is an injected `SeenStore`. Keeping it out
  means no tier-0 dependency, so the validator runs unchanged in a Worker.
- **Delivery and read signals.** For iMessage, read receipts, typing
  indicators, tapbacks and effects all need the SIP-disabled helper bundle. The
  Bot API has no delivery or read receipt for bots at all: a successful
  `sendMessage` means Telegram accepted the message, and nothing more is ever
  reported. The contract therefore exposes no delivered or read signal, so a
  state machine above it cannot accidentally branch on one.
- **Scheduling.** No cron, no queue, no quiet hours, no retry loop. The
  transport reports one typed failure per attempt; when to try again is the
  consumer's policy.
- **Opening conversations.** `chatGuidFor` is a parameter because a chat GUID
  only exists once a human has exchanged a first message with the handle.
