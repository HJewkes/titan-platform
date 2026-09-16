# chat-protocol

**Tier 0 · primitives.** No titan dependencies. `zod` v4 is a peer.

```sh
npm install @titan-design/chat-protocol zod
```

## The problem it solves

Five surfaces need to show a conversation: the coach channel, hitl gates, agent runs, the
agent-chat cross-session bus, and Claude Code channel input. Each one arrived with its own
shape, so every renderer and every store had to learn five vocabularies, and anything that
crossed between two of them lost detail nobody had written down.

The primitive is **one message document**. It is the Vercel AI SDK `UIMessage` / `parts[]`
model with **zero new part types**, plus an envelope for the four things it genuinely lacks:
a thread, a participant beyond the three roles, per-recipient delivery state, and
broker-set provenance. Titan-specific content rides the SDK's own `data-*` escape hatch.

## When to reach for it

Any surface that stores, renders or forwards a conversation, and any adapter that maps a
transport into one. Reach for [`messaging`](/reference/messaging) instead when you need to
actually move the bytes — it is the transport seam and stays free of this model on purpose.
Reach for [`hitl`](/reference/hitl) for the durable gate row; what lives here is a
render-time view of it.

## Example

Verified against 0.1.0 and `ai@7.0.102`.

```ts
import {
  fromMessagingInbound,
  toMessagingOutbound,
  toUIMessage,
} from "@titan-design/chat-protocol";

const message = fromMessagingInbound(
  { status: "accepted", handle: "+15550000000", guid: "g1", text: "sunday?" },
  { threadId: "coach", authorId: "lifter", createdAt: new Date().toISOString() },
);

render(toUIMessage(message));           // drop the envelope, get a plain UIMessage

const { send, dropped } = toMessagingOutbound(reply, "+15550000000");
if (dropped.length) warn(dropped);      // part types the seam cannot carry
```

A hitl gate becomes a `tool-gate` part in `approval-requested`, carrying its JSON Schema as
the approval descriptor:

```ts
import { fromHitlGate, toHitlAnswer } from "@titan-design/chat-protocol";

const message = fromHitlGate(gate, { threadId: "harness", authorId: "runner" });
const answer = toHitlAnswer(message);   // undefined while the gate is still open
```

## What it deliberately does not do

- **Transport.** No fetch, no WebSocket, no SSE, no streaming chunk protocol.
- **New part types.** Inventing a second protocol nobody speaks is the risk this package
  exists to avoid, and adding zero part types is the structural mitigation.
- **AG-UI.** Its unit of work is a *run*, and three of the five sources have no run. It
  stays an adapter target rather than the base.
- **Gate state.** `GateSnapshot` is a view. The durable row stays in `hitl`.
- **React.** The UI kit is a separate, higher-tier concern.

## Gotchas

- **A `data-*` key may not contain a hyphen after the prefix.** A Claude Code channel turns
  each `meta` entry into an attribute and silently drops any key that is not an identifier,
  so `data-gate-ref` would lose its routing context with no error. `dataPart` rejects it.
- **`inboundChatMessage` omits `provenance` rather than validating it.** A payload claiming
  a human endorsement is rejected, not stripped, because stripping turns a hard failure into
  a silent one. `markHumanEndorsed` is the only way one is minted.
- **`capDeliveryStatus` is a cap, not a setter.** `("read", "accepted")` returns `accepted`.
  Every transport titan speaks today reports acceptance and nothing after it.
- **`toHitlAnswer` returns `undefined` for a still-open gate and for a message with no gate
  part.** Both mean "no answer yet"; neither is an error.

## Where it came from

New, designed by the VW-390 agent-chat research lane on 2026-09-15 after surveying
`UIMessage`, AG-UI, assistant-ui, the Anthropic Messages API, the Claude Agent SDK, MCP
elicitation, A2A, OpenAI Responses and Matrix. The AI SDK part shapes are vendored rather
than imported, because a tier-0 package carries no runtime dependency beyond `zod`; `ai` is
a devDependency and one test round-trips a real `UIMessage` through the vendored schemas so
the subset cannot drift silently.
