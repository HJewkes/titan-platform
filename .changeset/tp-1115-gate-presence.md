---
"@titan-design/factory": minor
---

`gate resolve` in a shell agent-chat launched asks for owner presence before it resolves as the owner. A confirmed dialog resolves as `owner-terminal` with the proof id as `confirmEvent`; no proof resolves as `coordinator`, named by `AGENT_CHAT_NAME`, which hitl refuses. The dialog reason is built only from a gate id, decision and head sha that pass strict shapes, and a proof must be a v4 UUID. The owner-presence helper now builds into `native/build`, outside `dist`, so `pnpm build` no longer deletes it. `resolveGate` is async.
