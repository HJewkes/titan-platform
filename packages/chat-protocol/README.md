# @titan-design/chat-protocol

One message document for every agent-chat surface: the coach channel, hitl gates,
agent runs, the agent-chat cross-session bus, and Claude Code channel input. The
document is the Vercel AI SDK `UIMessage` / `parts[]` model with **zero new part
types**, plus a thin envelope for the four things it genuinely lacks — a thread, a
participant beyond the three roles, per-recipient delivery state, and broker-set
provenance.

Tier 0 of the titan-platform DAG (TP-64). No package dependencies, no transport,
no React. `zod` is a peer (v4).

## Why `UIMessage`, and why it is vendored rather than imported

`UIMessage` is the only surveyed model that already splits the durable message
object from the streaming chunk protocol, and its `tool-*` parts already carry an
approval state machine (`approval-requested`, `approval-responded`,
`output-denied`) that a Claude Code permission relay and a titan hitl gate both
map onto without a new type. Everything titan-specific rides the SDK's own
`data-*` escape hatch.

A tier-0 package carries no runtime dependency beyond zod, so the part shapes are
**vendored** here as a byte-compatible subset rather than re-exported from `ai`.
`ai` is a devDependency only. `src/ai-sdk.test.ts` is what stops that subset
drifting: it holds a fixture typed `satisfies UIMessage`, hands it to the SDK's own
`validateUIMessages`, parses every part through the zod schemas, and asserts the
result is equal field for field. Verified against `ai@7.0.102`.

The subset deliberately omits three SDK part kinds titan has no producer for:
`custom`, `dynamic-tool` and `reasoning-file`.

```ts
import { chatMessage, toUIMessage, type ChatMessage } from "@titan-design/chat-protocol";

const message: ChatMessage = chatMessage.parse(row);
render(toUIMessage(message)); // a plain UIMessage; the envelope is gone
```

## The two rules that carry weight

**A `data-*` key may not contain a hyphen after the prefix.** A Claude Code
channel turns every `meta` entry into an attribute and *silently drops* any key
that is not an identifier, so `data-gate-ref` would lose its routing context with
no error anywhere. `dataPart` rejects it instead.

```ts
dataPart.safeParse({ type: "data-gate_ref", data: {} }).success; // true
dataPart.safeParse({ type: "data-gate-ref", data: {} }).success; // false
```

**`provenance` is broker-set and unforgeable.** `inboundChatMessage` is a
`strictObject` that omits the field entirely rather than validating it, so a
transport payload claiming `{ authored: "agent", endorsedBy: "human" }` is
*rejected*, not stripped. Stripping would be worse: it turns a hard failure into
a silent one. `markHumanEndorsed` is the only way an endorsement is minted.

## Adapters

Pure functions, no I/O. The contracts they map are mirrored structurally rather
than imported, because `messaging` and `hitl` are tier 1 and this package is tier
0. Source of truth stays `packages/messaging/src/{contract,inbound}.ts` and
`packages/hitl/src/types.ts`.

```ts
import { fromMessagingInbound, toMessagingOutbound, deliveryFromSendResult } from "@titan-design/chat-protocol";

const message = fromMessagingInbound(inbound, { threadId, authorId, createdAt });
const { send, dropped } = toMessagingOutbound(message, handle);
// dropped lists part types the seam cannot carry; it never swallows one silently
```

```ts
import { fromHitlGate, toHitlAnswer } from "@titan-design/chat-protocol";

const message = fromHitlGate(gate, { threadId, authorId });
const answer = toHitlAnswer(message); // undefined while the gate is still open
```

A gate becomes a `tool-gate` part in `approval-requested`, carrying its JSON
Schema as the approval descriptor. The gate row stays in `@titan-design/hitl`:
this is a render-time view, and resolving still goes through `resolveGate`.

### The agent-chat bus

No adapter ships. `agent-chat` lives in a separate repository, so importing its
frame types would mean a runtime dependency a tier-0 package may not take. The
mapping, for whoever writes it at tier 1:

| agent-chat | chat-protocol |
|---|---|
| `from` (session name) | `authorId`; `HUMAN` is reserved |
| `toTag` fanout or peer pair | `threadId` |
| `message` / `broadcast` / `question` / `answer` | a message with one `text` part |
| the other ~22 `EVENT_KINDS` | thread events, **not** messages |
| `approval_request` | `tool-*` part in `approval-requested` |
| the `resolution` row | the same part advanced to `approval-responded` |
| `RecipientStatus` (six values) | one `DeliveryState` per recipient |
| `provenance: 'human-endorsed'` | `markHumanEndorsed`, broker side only |
| `audience[]`, `threadDepth`, `threadHint` | `metadata` |

## What each source loses

| Source | Thread | Author | Parts | What is lossy |
|---|---|---|---|---|
| **Coach channel** (`messaging`) | one per handle | `Participant.address` | one `text` part | **Delivery caps at `accepted`.** `SendResult.ok` means the server took it; there is no delivered or read signal. `SendInput` is `{handle, text}`, so a `file` part cannot be sent outbound at all — `toMessagingOutbound` reports it in `dropped`. `SendError.kind` becomes `DeliveryState.reason`; `too-long` is the composer's problem to split. |
| **hitl gates** | the thread that opened the gate | the opener; **a gate row has no author field** | `tool-gate` | A gate's schema is unrestricted JSON Schema while MCP elicitation allows only flat primitives, so a generic form renderer needs a raw-JSON fallback. `cancelled` and `expired` are distinct outcomes that both read back as `decline`, separable only by `reason`. `waitForGate` polls, so gate state is as stale as the poll interval until a transport adds a push path. |
| **Agent runs** | one per `sessionId` | assistant | `text`, `reasoning`, `tool-*` | **`thinking.signature` must round-trip verbatim** or a resumed run breaks; it rides `providerMetadata`, which this package treats as opaque and preserves. `AgentUsage` and `AgentFailure` have no message-level home and belong on `metadata`. |
| **agent-chat bus** | per peer pair or `toTag` | `from` | `text` | `RecipientStatus` has six values including `held` and `no_channel`; `no_channel` means delivered to an inbox nothing is watching, which is why per-recipient `DeliveryState` cannot collapse to one status on the message. 26 event kinds exist; only four are conversational. |
| **Claude Code channel** | one per session | the channel server | one `text` part | **Outbound is string-only**: any structured part must be serialised into `content` first. **Meta keys must be identifiers**, which is what `DATA_PART_KEY_PATTERN` enforces. The 5-character `request_id` is the only correlation handle, and verdicts do not persist. |
| **vmcp push** | one per slot | device | `text` plus `data-*` | Slot routing is not uniform: several event types carry no `slot` key at all, and two carry `slot_id`/`partner_slot_id` instead, so a thread-per-slot model still needs a device-level thread. `rep_finalized` fires when the *next* rep begins, so naive chronological rendering reads one rep late. |

## Delivery state

`capDeliveryStatus(status, ceiling)` clamps a claim to what a transport can
actually observe. `TRANSPORT_DELIVERY_CEILING` is `accepted`, because every
transport titan speaks today — BlueBubbles without the private API, the Telegram
Bot API, the agent-chat bus — reports that the server took the message and
nothing after that. `held` and `undeliverable` are outcomes rather than progress,
so a cap never rewrites them.

## What this package deliberately does not do

- **Transport.** No fetch, no WebSocket, no SSE. `@titan-design/messaging` stays
  the transport seam and is not absorbed; the DAG would permit it to import this
  package, and it should not, so it stays usable by a scheduler that wants no
  conversation model.
- **New part types.** Inventing a second protocol nobody speaks is the real risk
  here, and adding zero part types is the structural mitigation. Drop the
  envelope and the result is a plain `UIMessage`.
- **AG-UI.** Its unit of work is a *run*, and three of the five sources above have
  no run. It stays an adapter target, not the base.
- **Streaming.** The message document only. The AI SDK's chunk protocol is the
  transport lane's decision.
- **Gate state.** `GateSnapshot` is a render-time view. The durable row lives in
  `@titan-design/hitl` precisely so pending work survives the process that opened
  it.

## Gotchas

- `capDeliveryStatus` is a cap, not a setter. Called with `("read", "accepted")`
  it returns `accepted` — the claim is silently weakened, which is the point.
- `toHitlAnswer` returns `undefined` for a still-open gate *and* for a message
  with no gate part. Both mean "no answer yet"; neither is an error.
- `fromUIMessage` picks fields explicitly rather than spreading, so a `UIMessage`
  off the wire carrying an extra `provenance` key cannot smuggle it through.
- The vendored subset is checked against `ai` only by `src/ai-sdk.test.ts`. If the
  SDK adds a part kind, nothing fails until someone widens that fixture.
