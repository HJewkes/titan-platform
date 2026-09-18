# messaging

**Tier 1 · engines.** No titan dependencies. `zod` v4 is a peer.

```sh
npm install @titan-design/messaging zod
```

## The problem it solves

Sending a person a text message drags a vendor into your codebase. A BlueBubbles chat GUID,
a Telegram chat id, two different error envelopes, two different webhook-authentication
schemes, and a `parse_mode` that silently mangles an apostrophe. Every layer above — the
scheduler, the protocol state machine, the composer — ends up knowing which one you picked.

The seam here is one method wide:

```ts
interface MessageTransport {
  send(input: { handle: string; text: string }): Promise<SendResult>;
}
```

Everything above that seam sees a handle, a string, and a typed failure. The core is
**fetch-only** — no `node:` imports anywhere — so the same build runs in a Cloudflare
Worker, in a daemon, and under vitest.

## When to reach for it

You want to text a human from a program, and you would rather not care whether it goes out
over iMessage or Telegram. Or you want just the inbound half: `validateInbound` and
`validateTelegramWebhook` are pure functions you can mount in any HTTP handler.

## Example

Verified against 0.1.0.

`MockTransport` implements the whole contract in memory, so a consumer's retry and ceiling
logic is testable with no Apple ID, no second macOS user, and no server:

```ts
import { MockTransport } from "@titan-design/messaging";

const transport = new MockTransport();
transport.failNext({ kind: "unreachable", message: "dark" });

await transport.send({ handle: "+15550000000", text: "one" });
// { ok: false, error: { kind: 'unreachable', message: 'dark' } }
await transport.send({ handle: "+15550000000", text: "two" });
// { ok: true, messageGuid: 'mock-2' }

transport.sent.length; // 2 — a scripted failure is still a recorded attempt
```

## Send

`BlueBubblesTransport` talks to a [BlueBubbles Server](https://bluebubbles.app) over its
REST API. iMessage cannot open a conversation from an API call, so the chat GUID is resolved
by the caller and a handle with no existing chat is a typed failure, not an exception.

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
    case "unreachable":   // the session is dark; see Liveness
    case "unauthorized":  // wrong server password
    case "too-long":      // carries limit and length, so a composer can split
    case "rejected":      // 4xx, result.error.message is the server's own text
    case "unknown":       // 5xx, or a chatGuidFor that threw
  }
}
```

`ok: true` means the server accepted the message for sending, and nothing more. Errors —
including the ones `fetch` itself raises with the URL inside them — are redacted before they
leave the transport, so the server password never reaches a log line, a thrown error, or a
result object.

## Inbound

BlueBubbles publishes no request-signature scheme. The boundary is therefore a secret path
segment, a sender allowlist, a GUID dedupe and a length cap, and `validateInbound` applies
all four. The secret is compared in constant time. Dedupe storage is injected, so the
validator needs no database and stays runtime-neutral.

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

A rejection carries exactly one reason: `bad-secret`, `malformed`, `from-me`,
`sender-not-allowed`, `too-long` or `duplicate`. `SeenStore { has(guid), add(guid) }` accepts
sync or async implementations; only the in-memory one ships here.

## Liveness

macOS auto-logs in exactly one user at boot, so after any reboot or OS update the sending
session is dark until a human fast-user-switches into it. Dark is an expected state, not an
exception, and a consumer should probe before it sends.

```ts
import { probeLiveness } from "@titan-design/messaging";

const liveness = await probeLiveness(config, { timeoutMs: 2000 });
if (liveness.state === "dark") {
  alertHuman(liveness.reason); // unreachable | unauthorized | timeout | bad-response
}
```

`alive` carries `serverVersion`, `osVersion` and `privateApi` when the server reports them.
The probe races its own timer and aborts the request it gave up on, so a hung server cannot
wedge a caller's tick.

## Telegram

`TelegramTransport` implements the same `MessageTransport` over the
[Bot API](https://core.telegram.org/bots/api). A bot cannot open a conversation either: the
person messages the bot first, and the chat id is resolved by the caller exactly like the
BlueBubbles chat GUID. The token sits in the URL path (`/bot<token>/sendMessage`), so every
error is redacted on the way out.

```ts
import { createTelegramTransport } from "@titan-design/messaging";

const transport = createTelegramTransport({
  token: config.telegramBotToken,   // never read from env by this package
  chatIdFor: (handle) => chatIds.get(handle),
});

const result = await transport.send({ handle: "lifter", text: "sunday?" });
if (!result.ok && result.error.kind === "too-long") {
  split(result.error.length, result.error.limit); // TELEGRAM_MAX_TEXT_LENGTH, 4096
}
```

`SendInput.buttons` is optional and channel-neutral: rows of `{ label, data }`. Telegram
renders them as an inline keyboard with `data` as `callback_data`; BlueBubbles ignores them,
because iMessage has no keyboards. Telegram caps `callback_data` at 64 UTF-8 bytes
(`TELEGRAM_MAX_CALLBACK_DATA_BYTES`), so longer data or an empty label fails with
`bad-buttons` before any call. The consumer owns the data format; relay uses
`v1|<action>|<slot>|<date>`.

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

Inbound arrives either way Telegram offers. `pollUpdates` is the long poll a daemon runs. It
tracks the offset (`last update_id + 1`), acknowledges every update it saw, yields text
messages and button taps from an allowed chat, and returns when the signal aborts. Each item
is a `TelegramInbound`, discriminated on `kind`: `"text"` carries `text`, and `"callback"`
carries `data`, `callbackQueryId` and the `messageId` the button sat on.

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

Answer every tap with `answerCallbackQuery(config, callbackQueryId, text?)`, or the button
keeps spinning on the phone. It never throws; a failure comes back as `{ ok: false, reason }`
with the token redacted.

`validateTelegramWebhook` is the push equivalent, over the `X-Telegram-Bot-Api-Secret-Token`
header that Telegram echoes from `setWebhook`: the same constant-time compare, a chat
allowlist, a length cap on text, and an `update_id` dedupe through the same `SeenStore`. It
reads the same two shapes as `pollUpdates` and returns the same `TelegramInbound` on accept.
Its rejection reasons are `bad-secret`, `malformed`, `not-text`, `sender-not-allowed`,
`too-long` and `duplicate`.

`probeTelegramLiveness(config, { timeoutMs })` calls `getMe`, the documented way to test a
token, so one probe answers both "does the API answer" and "does this token still work". It
returns the same `alive` / `dark` shape as `probeLiveness`, with the bot username on `alive`.

## What it deliberately does not do

- **Secrets.** The server password, the bot token and the webhook secret are configuration
  values the caller passes in. Nothing here reads an environment variable or a file.
- **Persistence.** The dedupe is an injected `SeenStore`. Keeping it out means no tier-0
  dependency, so the validator runs unchanged in a Worker.
- **Delivery and read signals.** iMessage read receipts, typing indicators and tapbacks all
  need the SIP-disabled helper bundle. The Bot API has no delivery or read receipt for bots
  at all. The contract exposes neither, so a state machine above it cannot branch on one.
- **Scheduling.** No cron, no queue, no quiet hours, no retry loop. The transport reports one
  typed failure per attempt; when to try again is the consumer's policy.
- **Opening conversations.** `chatGuidFor` and `chatIdFor` are parameters because the
  identifier only exists once a human has sent the first message.

## Gotchas

**`no-chat` is not an error to retry.** It means no conversation exists yet, and no number of
retries will create one. A human has to send the first message. Both adapters return it:
BlueBubbles when `chatGuidFor` yields nothing, Telegram on a 400 whose description reads
"chat not found".

**`too-long` is checked before the call, not after.** That is why it is its own `SendError`
kind rather than a `rejected` with a status: a composer should split the text, not back off.

**A tap without `data` or `message` is skipped, not yielded.** Telegram omits `message` for a
button on an inline-mode message and omits `data` for a game button. Neither can be routed, so
the webhook rejects both as `not-text`.

**A rejected inbound GUID is never recorded.** A genuine retry of a rejected request is still
judged on its merits, so a transient allowlist misconfiguration does not permanently swallow
a message.

**`pollUpdates` acknowledges what it skips.** A photo, an edit, a stranger, or a shape this
package does not read all advance the offset and are dropped rather than thrown. Long polling
would otherwise stall forever on one unreadable update.

**`readChatIds` passes no offset on purpose.** It confirms nothing, so a daemon polling the
same bot still sees those updates. It is the human's one-time setup call, not a consumer API.

## Where it came from

TP-59, for a coaching product that texts a lifter over iMessage. TP-60 added the Telegram
adapter, which is what proved the contract was actually vendor-neutral rather than
BlueBubbles with extra steps.
