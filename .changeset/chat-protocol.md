---
"@titan-design/chat-protocol": minor
---

Add the chat-protocol package: one canonical message document for every agent-chat
surface. The document is the Vercel AI SDK `UIMessage` / `parts[]` model with zero
new part types, vendored as a byte-compatible subset so a tier-0 package keeps no
runtime dependency beyond `zod`. On top of it sits a thin envelope — thread,
participant, per-recipient delivery state, broker-set provenance — plus pure
adapters to and from `@titan-design/messaging` and `@titan-design/hitl`, and a
delivery-status cap that clamps a claim to what a transport can actually observe.
