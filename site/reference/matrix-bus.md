# matrix-bus

**Tier 1.** No titan dependencies.

```sh
npm install @titan-design/matrix-bus
```

## The problem it solves

Agents on several machines post items that only the owner may resolve, and the owner
resolves them from a stock Matrix client on a phone. That needs a small, exact slice of
the Matrix client-server API, a structured record that stock clients still render and
push, and a fold that trusts only the owner. matrix-js-sdk brings a full client state
machine and a Node-leaning dependency tree for what is send, state, messages, sync and
one login. This package speaks those endpoints over `fetch` and nothing else.

## When to reach for it

- A process that mirrors pending work into a Matrix room and folds the owner's answers
  back (the agent-chat mirror through `@titan-design/queue-mirror`, relay notices, a
  hitl gate mirror).
- A one-off owner script that creates `#queue` or renders a machine's appservice
  registration.

Reach elsewhere for the projection loop itself (cursor persistence, `msg_id` to event id
mapping, edits on local resolution, secret redaction): that is `queue-mirror` (TP-316).

## Example

Verified against Tuwunel 1.9.2 with the tp301 compose.

```ts
import { AppserviceClient, encodeItem, foldResolution } from "@titan-design/matrix-bus";

const mirror = new AppserviceClient({ baseUrl, asToken, sender: "@ac-edge1:hub.example" });
const content = encodeItem({
  kind: "approval_request", machine: "edge1", session: "tp-coord", msg_id: "a3f91c",
  at: Date.now(), tool_name: "Bash", input_preview: "gh run watch 1841",
  truncated: false, redacted: false,
});
const { event_id } = await mirror.send(queueRoomId, "m.room.message", content);
const open = new Map([[event_id, "approval_request" as const]]);

for await (const { since, events } of mirror.syncLoop({ since: saved, signal })) {
  for (const event of events) {
    const verdict = foldResolution(event, { ownerUserId: "@owner:hub.example", itemEventIds: open });
    if (verdict) apply(verdict); // { itemEventId, verdict: "allow" }
  }
  await persist(since);
}
```

## The pieces

**`AppserviceClient({ baseUrl, asToken, userId?, sender? })`.** Every request carries
`?user_id=<userId>` when `userId` is set and differs from `sender`, the user the token
belongs to. An appservice client acting as its own `sender_localpart` user passes only
`sender`; a masqueraded agent passes `userId`. `loginPassword(baseUrl, user, password)`
returns the same class for an ordinary account, with `sender` set, so it never
masquerades. `send` and `sendState` reject with `ContentTooLargeError` before any request
when content exceeds 60,000 bytes. Failures reject with `MatrixError` (`status`,
`errcode`, `body`).

**`syncLoop({ since, filter, timeoutMs, signal })`.** An async iterator yielding
`{ since, events, limited, prev_batch }` per `/sync` response, with `room_id` added to
each timeline event. Handle every event in the batch first, then persist `since`; a
crash between handling and persisting replays the batch, so the caller dedupes by
applied event id. The loop ends quietly on abort and rethrows anything else; retry and
backoff belong to the caller.

**Items.** `encodeItem(item, formattedBody?)` returns `m.room.message` content with
`msgtype: "m.text"`, a `body` rendered as kind and session on line 1, the full preview or
text, and a last line naming the accepted reactions, plus the `io.titan.item` record.
The item's free `text` goes into `body` only. `decodeItem(content)` returns the record,
or null when the key is missing, `v` is not 1 or a field has the wrong type.

**`foldResolution(event, { ownerUserId, itemEventIds })`.** Section 4.3 of the stage-1
plan. `itemEventIds` maps each open item's event id to its kind, because the same ✅
means `allow` on a permission and `approve` on an endorsement.

| Kind | ✅ 👍, reply `allow` or `approve` | ❌ 👎, reply `deny` or `dismiss` | other reply |
|---|---|---|---|
| `approval_request` | `allow` | `deny` | null |
| `endorse_request` | `approve` | `dismiss` | null |
| `question` | ✅ 👍 null; the words are an `answer` | `dismiss` | `answer` with text |
| `notice`, `message` | `dismiss` | `dismiss` | null |

Replies match on the last non-empty line, trimmed and case-insensitive, after a legacy
reply fallback is stripped. An `io.titan.resolution` event with `content.decision` (one
of the four words, or `answer` with `content.text`) and an `m.relates_to.event_id` folds
the same way. The sender must equal `ownerUserId`, and the reaction (`m.annotation`),
reply (`m.in_reply_to`) or resolution must point at a key of `itemEventIds`. Everything
else is null.

**`queuePowerLevels()` and `bootstrapQueueRoom(owner, { alias, mirrorUserIds })`.** The
owner creates `#queue` at the server's default version (v12) with those levels, so the
owner is the creator and holds unbounded power; `users` stays empty because v12 rejects
listing creators. Members post at 0; `m.reaction`, `io.titan.resolution` and power
changes need 100, so only the owner can react. An alias that already resolves returns
its room id.

**`renderRegistration(options)`.** YAML for one machine's appservice: exclusive users
regex `^@ac-<machine>-.*:<server>$` with the server name regex-escaped, and `url: null`
for a receive-only edge that pulls with `/sync`. Machine names are letters and digits
only, so no machine's prefix can be a prefix of another's.

## What it deliberately does not do

- No redaction of secrets and no truncation policy. The mirror redacts, sets `redacted`
  or `truncated`, and removes such items from `itemEventIds` so nothing folds for them.
  `encodeItem` only renders the matching footer line.
- No retry, backoff, persistence or end-to-end encryption.
- No `node:` imports. A token file or other filesystem helper would go under a `/node`
  subpath.

## Gotchas

- The server adds `notifications: { room: 50 }` to the power levels it stores, so compare
  with `toMatchObject`, not strict equality.
- `userId` equal to `sender` does not masquerade. Omitting `sender` on an appservice
  client makes every call carry `?user_id=`, which is harmless for the sender itself but
  wrong for a password session.
- ✅ and 👍 on a question fold to nothing, because an answer needs text; ❌ and 👎 dismiss it.

## Integration test

`src/integration.test.ts` is skipped unless `MATRIX_BASE_URL` is set. It also reads
`MATRIX_SERVER_NAME`, `MATRIX_OWNER_PASSWORD`, `MATRIX_EDGE_AS_TOKEN`, and optionally
`MATRIX_OWNER_USER` (default `owner`) and `MATRIX_EDGE_MACHINE` (default `edge1`). Run it
against the tp301 compose or `deploy/hub` on 127.0.0.1:8008.

## Where it came from

Extracted from the TP-301 and TP-302 spikes (`tp301-matrix-substrate` and
`tp302-claude-p-host`), which spoke the same endpoints over raw `fetch` and, in tp301,
matrix-js-sdk. The fold follows tp301's sender-checked `foldEndorsed`.
