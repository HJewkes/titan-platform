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
    case "unreachable":   // the coach session is dark; see Liveness
    case "unauthorized":  // wrong server password
    case "rejected":      // 4xx, result.error.message is the server's own text
    case "unknown":       // 5xx or a thrown chatGuidFor
  }
}
```

`ok: true` means the server accepted the message for sending. Nothing more:
there is no delivered or read signal (see below). Errors, including the ones
raised by `fetch` itself, are redacted before they leave the transport, so the
server password never reaches a log line, a thrown error, or a result object.

`MockTransport` implements the same contract in memory. It records every send,
including one it was scripted to fail, so a consumer can test its retry and
ceiling logic with no Apple ID and no server:

```ts
const transport = new MockTransport();
transport.failNext({ kind: "unreachable", message: "dark" });
await transport.send({ handle: "+15550000000", text: "one" }); // recorded, failed
```

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

## What this package deliberately does not do

- **Secrets.** The server password and the webhook secret are configuration
  values passed in by the caller. Nothing here reads an environment variable or
  a file, and nothing here writes one.
- **Persistence.** The GUID dedupe is an injected `SeenStore`. Keeping it out
  means no tier-0 dependency, so the validator runs unchanged in a Worker.
- **Private API features.** Read receipts, typing indicators, tapbacks and
  effects all need the SIP-disabled helper bundle. The contract exposes no
  delivered or read signal at all, so a state machine above it cannot
  accidentally branch on one.
- **Scheduling.** No cron, no queue, no quiet hours, no retry loop. The
  transport reports one typed failure per attempt; when to try again is the
  consumer's policy.
- **Opening conversations.** `chatGuidFor` is a parameter because a chat GUID
  only exists once a human has exchanged a first message with the handle.
